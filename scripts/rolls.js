/**
 * Layer 3: the roll layer. Sets a test's advantage mode from the roll rules of every effect the roller and its
 * single target have (conditions, situational effects, the stance marker, any effect with rules of its own; see
 * scripts/rules.js), notes why on the chat card, and uses up effects that a test consumes.
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
import { skillPenalty } from './mechanics.js';
import { attackTypeOf, beyondSenses, collectModifiers, describeModifiers, needsSensesRange, netMode, sideConditions, sideSources, skillPenaltyFormula } from './logic/rolls.js';
import { consumeEffect } from './relay.js';
import { ruleEffects } from './rules.js';
import { conditionMode, effectRulesMode, featureMode, SETTINGS, weakerMode } from './settings.js';
import { activateGrantButton, endOn, singleTarget } from './situational.js';
import { esc, safe, warn } from './util.js';

const CONTEXTS = ['Skill', 'Item', 'Attack'];
const PENDING_MS = 60 * 1000;

/** Attacks whose dialog got our modifiers: item uuid → {mods, at, submitted}. */
const pendingAttacks = new Map();

export function registerRollHooks() {
    for (const context of CONTEXTS) {
        Hooks.on(`${SYSTEM_ID}.pre${context}Roll`, safe(`pre${context}Roll (exhaustion)`, (roll, source, config) => onPreRollExhaustion(context, roll, source, config)));
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

/**
 * Mode for one source of modifiers (a source's `modeKey`, see `rollSources`): the weaker of the roll layer's
 * setting and the source's own. Situational effects and stances follow the roll layer's setting alone; a condition
 * also its own setting; any other effect also "Rules on other effects".
 */
export function modeOf(key) {
    const rolls = rollsMode();
    if (key.startsWith('situational:')) return rolls;
    if (key.startsWith('effect:')) return weakerMode(rolls, effectRulesMode(null));
    return weakerMode(rolls, conditionMode(key));
}

/**
 * What the roll layer needs to know about an actor: one source per effect with roll rules (and the actor's stance
 * from the table when no marker effect carries it), plus what the facts of a test say about it: the conditions it
 * has and the stance it is in (scripts/logic/predicates.js).
 */
export function sideOf(actor) {
    if (!actor) return null;
    // The same effects as the mechanics layer: the actor's own and those its items transfer (#4).
    const rows = ruleEffects(actor, { includeEmpty: true, transferred: true }).map((row) => ({ ...row, onActor: row.effect.parent === actor }));
    const stance = actor.getFlag?.(SYSTEM_ID, 'mode.stance') ?? null;
    const sources = sideSources(rows, { stance, conditions: CONDITIONS_BY_ID, situational: SITUATIONAL_BY_ID });
    return { uuid: actor.uuid, name: actor.token?.name ?? actor.name, sources, conditions: sideConditions(rows), stance };
}

function actorOf(context, source, config) {
    if (context === 'Skill') return source ?? null;
    return config?.actor ?? source?.actor ?? null;
}

/**
 * A test as the roll layer sees it: the two sides and the test, ready for `collectModifiers` and `rollFacts`.
 * @param {Actor} actor the roller
 * @param {{context: string, skill?: string | null, attackType?: string | null}} test
 * @param {{target?: Actor | null}} [options] target: the target to use (default: the user's single target, whose
 *   distance is then measured when a rule of either side asks whether it is beyond the roller's senses)
 * @returns {{roller: object, target: object | null, test: object}}
 */
export function situationFor(actor, test, { target } = {}) {
    const roller = sideOf(actor);
    const measured = target === undefined;
    const targetActor = measured ? singleTarget(actor) : target;
    const targetSide = sideOf(targetActor);
    if (measured && targetActor && (needsSensesRange(roller, 'self') || needsSensesRange(targetSide, 'target'))) {
        test = { ...test, beyondSenses: targetBeyondSenses(actor) };
    }
    return { roller, target: targetSide, test };
}

/**
 * The modifiers a test gets.
 * @param {Actor} actor the roller
 * @param {{context: string, skill?: string | null, attackType?: string | null}} test
 * @param {{target?: Actor | null}} [options] as for `situationFor`
 */
export function modifiersFor(actor, test, options) {
    return collectModifiers(situationFor(actor, test, options), { modeOf });
}

/** The roller's senses range in the scene's units (the system's derived value: override or derived, plus bonus). */
function sensesRange(actor) {
    const range = actor?.system?.senses?.range;
    if (!range) return null;
    if (Number.isFinite(range.value)) return range.value;
    const base = range.useOverride ? range.override : range.derived;
    return Number.isFinite(base) ? base + (Number(range.bonus) || 0) : null;
}

/** Whether the user's single targeted token is beyond the roller's senses range (null: can't tell). */
function targetBeyondSenses(actor) {
    const targets = [...(game.user?.targets ?? [])];
    const from = actor?.getActiveTokens?.()?.[0];
    const to = targets.length === 1 ? targets[0] : null;
    let distance = null;
    if (from?.center && to?.center && globalThis.canvas?.grid?.measurePath) {
        distance = canvas.grid.measurePath([from.center, to.center]).distance;
    }
    return beyondSenses({ distance, sensesRange: sensesRange(actor), obscuredAffected: actor?.system?.senses?.obscuredAffected });
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
        ...roll.options[MODULE_ID],
        note: describeModifiers(mods),
        consume: mods.filter((m) => m.active && m.consume).map((m) => m.consume),
    };
}

/* --- Exhausted (and other skill modifiers) on a test rolled with another attribute --- */

/**
 * The system builds a skill test's modifier from the skill's `mod.value` (which carries the engine's skill
 * modifiers: the Exhausted penalty, and any effect's `skillModifier` rules), except when the test uses another
 * attribute: `actor.rollSkill(id, {attribute})` and an attribute changed in the roll dialog both rebuild it from
 * rank + attribute only, dropping every skill bonus. The engine's modifiers for that skill are added back as their
 * own term then (once per roll). A bonus (an all-skills or listed-skill bonus in full mode) is added back too.
 */
function onPreRollExhaustion(context, roll, source, config) {
    const actor = actorOf(context, source, config);
    if (!actor) return;
    roll.options[MODULE_ID] = { ...roll.options[MODULE_ID], actorUuid: actor.uuid, skill: config?.data?.skill?.id ?? null };
    // rollSkill with an explicit attribute leaves the skill's bonus out from the start.
    if (context === 'Skill' && config?.attribute) addExhaustionTerm(roll, actor);
}

function addExhaustionTerm(roll, actor) {
    const state = (roll.options[MODULE_ID] ??= {});
    if (state.exhaustion) return;
    const penalty = skillPenalty(actor, state.skill ?? undefined);
    const formula = skillPenaltyFormula(penalty);
    if (!formula || !Array.isArray(roll.terms) || typeof Roll !== 'function') return;
    roll.terms = roll.terms.concat(new Roll(formula).terms.slice(1));
    if (typeof roll.resetFormula === 'function') roll.resetFormula();
    state.exhaustion = penalty;
}

function rollActor(roll) {
    const uuid = roll?.options?.[MODULE_ID]?.actorUuid;
    return uuid ? (globalThis.fromUuidSync?.(uuid) ?? null) : null;
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
    D20Roll.prototype.configureDialog = async function (data, ...rest) {
        try {
            if (data?.skillTest && data.skillTest.advantageMode == null && this.options?.advantageMode) {
                data.skillTest.advantageMode = this.options.advantageMode;
            }
        } catch (err) {
            console.error(`${MODULE_ID} | roll dialog preset failed`, err);
        }
        const modifierTerm = this.terms?.[2];
        const result = await original.call(this, data, ...rest);
        try {
            // Another attribute picked in the dialog: the system replaced the modifier term without skill bonuses.
            if (result && Array.isArray(this.terms) && this.terms[2] !== modifierTerm) {
                const actor = rollActor(this);
                if (actor) addExhaustionTerm(this, actor);
            }
        } catch (err) {
            console.error(`${MODULE_ID} | keeping Exhausted on another attribute failed`, err);
        }
        return result;
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
