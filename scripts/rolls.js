/**
 * Layer 3: the roll layer. Sets a test's advantage mode from conditions and situational effects (the roller's
 * and its single target's), notes why on the chat card, and uses up effects that a test consumes.
 *
 * How it reaches the system's rolls (cosmere-rpg 3.1.2):
 * - `cosmere-rpg.pre<Skill|Item|Attack>Roll(roll, source, config)` fires for every d20 test before its dialog
 *   (and on fast-forward): we set `roll.options.advantageMode` and rebuild the d20.
 * - The system's roll dialog doesn't start from the roll's mode, so `D20Roll.prototype.configureDialog` is wrapped
 *   to pass it in: the dialog opens with our choice selected and the player can change it.
 * - Attacks have their own dialog, which does start from `options.skillTest.advantageMode`: set in
 *   `cosmere-rpg.preAttackRollConfiguration`. The attack's test is then rolled without a dialog, so the
 *   pre-roll hook must not apply the modifiers a second time: a short-lived note per item says it's done.
 * - `cosmere-rpg.<skill|item|attack>Roll` fires after the roll is evaluated: effects used up by it end then.
 */
import { CONDITIONS_BY_ID } from '../data/conditions.js';
import { SITUATIONAL_BY_ID } from '../data/situational.js';
import { MODES, MODULE_ID, SYSTEM_ID } from './constants.js';
import { activeConditions } from './mechanics.js';
import { attackTypeOf, collectModifiers, describeModifiers, netMode } from './logic/rolls.js';
import { consumeEffect } from './relay.js';
import { conditionMode, featureMode, SETTINGS, weakerMode } from './settings.js';
import { activateGrantButton, endOn, singleTarget, situationalEffects } from './situational.js';
import { esc, safe, warn } from './util.js';

const CONTEXTS = ['Skill', 'Item', 'Attack'];
const PENDING_MS = 60 * 1000;

/** Attacks whose dialog got our modifiers: item uuid → {mods, at, submitted}. */
const pendingAttacks = new Map();

export function registerRollHooks() {
    for (const context of CONTEXTS) {
        Hooks.on(`${SYSTEM_ID}.pre${context}Roll`, safe(`pre${context}Roll`, (roll, source, config) => onPreRoll(context, roll, source, config)));
        Hooks.on(`${SYSTEM_ID}.${context.toLowerCase()}Roll`, safe(`${context.toLowerCase()}Roll`, (roll) => onRolled(roll)));
    }
    Hooks.on(`${SYSTEM_ID}.preAttackRollConfiguration`, safe('preAttackRollConfiguration', onPreAttackConfiguration));
    Hooks.on(
        `${SYSTEM_ID}.attackRollConfiguration`,
        safe('attackRollConfiguration', (options, item) => {
            const entry = item?.uuid ? pendingAttacks.get(item.uuid) : null;
            if (entry) Object.assign(entry, { submitted: true, at: Date.now() });
        }),
    );
    const renderHook = (game.release?.generation ?? 13) >= 13 ? 'renderChatMessageHTML' : 'renderChatMessage';
    Hooks.on(renderHook, safe(renderHook, onRenderMessage));
    wrapRollDialog();
}

/* --- Reading the situation --- */

function rollsMode() {
    return featureMode(SETTINGS.ROLLS);
}

/** Mode for one source of modifiers: the weaker of the roll layer's setting and the source's own. */
function modeOf(key) {
    const rolls = rollsMode();
    if (key.startsWith('situational:')) return rolls;
    return weakerMode(rolls, conditionMode(key));
}

/** What the roll layer needs to know about an actor. */
export function sideOf(actor) {
    if (!actor) return null;
    return {
        uuid: actor.uuid,
        name: actor.token?.name ?? actor.name,
        conditions: activeConditions(actor).map((c) => c.id),
        situational: situationalEffects(actor).map(({ id, effectId, value }) => ({ id, effectId, value })),
        stance: actor.getFlag?.(SYSTEM_ID, 'mode.stance') ?? null,
    };
}

function actorOf(context, source, config) {
    if (context === 'Skill') return source ?? null;
    return config?.actor ?? source?.actor ?? null;
}

function modifiersFor(actor, test) {
    return collectModifiers(
        { roller: sideOf(actor), target: sideOf(singleTarget(actor)), test },
        { conditions: CONDITIONS_BY_ID, situational: SITUATIONAL_BY_ID, modeOf },
    );
}

/* --- Hooks --- */

function onPreAttackConfiguration(options, item) {
    if (rollsMode() === MODES.OFF || !options?.skillTest) return;
    const actor = options.actor ?? item?.actor;
    if (!actor) return;
    const mods = modifiersFor(actor, {
        context: 'Attack',
        skill: options.skillTest.skill ?? item.system?.skillTest?.resolvedSkill ?? item.system?.skillTest?.skill ?? null,
        attackType: attackTypeOf(item),
    });
    pendingAttacks.set(item.uuid, { mods, at: Date.now(), submitted: false });
    if (!mods.length) return;
    const base = options.skillTest.advantageMode ?? 'none';
    options.skillTest.advantageMode = netMode(base, mods);
}

function takePending(item) {
    const entry = item?.uuid ? pendingAttacks.get(item.uuid) : null;
    if (item?.uuid) pendingAttacks.delete(item.uuid);
    // Only a dialog the player submitted just now counts; a cancelled one is ignored.
    return entry?.submitted && Date.now() - entry.at < PENDING_MS ? entry : null;
}

function onPreRoll(context, roll, source, config) {
    if (rollsMode() === MODES.OFF) return;
    const actor = actorOf(context, source, config);
    if (!actor) return;

    if (context === 'Attack') void endOn(actor, 'attack');

    const pending = context === 'Attack' ? takePending(source) : null;
    const mods =
        pending?.mods ??
        modifiersFor(actor, {
            context,
            skill: config?.data?.skill?.id ?? null,
            attackType: context === 'Attack' ? attackTypeOf(source) : null,
        });
    if (!mods.length) return;

    // After an attack dialog, the player's choice already includes ours: don't apply twice.
    if (!pending) {
        const base = roll.options.advantageMode ?? 'none';
        const net = netMode(base, mods);
        if (net !== base) {
            roll.options.advantageMode = net;
            if (typeof roll.configureModifiers === 'function') roll.configureModifiers();
            else warn('D20Roll.configureModifiers is missing; the advantage mode may not reach the dice');
        }
    }
    roll.options[MODULE_ID] = {
        note: describeModifiers(mods),
        consume: mods.filter((m) => m.active && m.consume).map((m) => m.consume),
    };
}

async function onRolled(roll) {
    const consume = roll?.options?.[MODULE_ID]?.consume ?? [];
    for (const { actorUuid, effectId } of consume) await consumeEffect(actorUuid, effectId);
}

/* --- The roll dialog starts from the roll's mode --- */

let wrapped = false;
function wrapRollDialog() {
    if (wrapped) return;
    const D20Roll = (CONFIG.Dice?.rolls ?? []).find((cls) => cls?.name === 'D20Roll');
    const original = D20Roll?.prototype?.configureDialog;
    if (typeof original !== 'function') {
        warn('D20Roll.configureDialog not found; the roll dialog will not show condition advantages');
        return;
    }
    D20Roll.prototype.configureDialog = function (data, ...rest) {
        try {
            if (data?.skillTest && data.skillTest.advantageMode == null && this.options?.advantageMode) {
                data.skillTest.advantageMode = this.options.advantageMode;
            }
        } catch (err) {
            console.error(`${MODULE_ID} | roll dialog preset failed`, err);
        }
        return original.call(this, data, ...rest);
    };
    wrapped = true;
}

/* --- Chat card note --- */

function onRenderMessage(message, html) {
    const root = globalThis.HTMLElement && html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!root) return;
    activateGrantButton(message, root);

    const notes = (message.rolls ?? []).map((r) => r?.options?.[MODULE_ID]?.note).filter(Boolean);
    if (!notes.length || root.querySelector(`.${MODULE_ID}-roll-note`)) return;
    const div = document.createElement('div');
    div.className = `${MODULE_ID}-roll-note`;
    div.style.cssText = 'font-size: var(--font-size-12, 12px); opacity: 0.85; margin: 2px 0 4px;';
    div.innerHTML = [...new Set(notes)].map((n) => `<p>${esc(n)}</p>`).join('');
    // Beside the content, not inside it: the system's renderHTML replaces `.message-content` with its own card
    // after this hook has run (cosmere-rpg 3.1.2, seen live 2026-11-25), which would drop a note put inside.
    const content = root.querySelector('.message-content');
    if (content?.parentElement) content.before(div);
    else root.prepend(div);
}
