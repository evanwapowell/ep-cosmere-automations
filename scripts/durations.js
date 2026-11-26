/**
 * Layer 4: durations and expiry, with Cosmere's turn rules.
 *
 * Turn and round events come from the combat's turn pointer (`updateCombat` with `turn` or `round`):
 * Advanced Encounters starts a turn by pointing at the combatant and ends it by pointing at nobody; plain Foundry
 * moves the pointer from one combatant to the next. The active GM's client compares the pointer with the last one
 * it saw for that combat and turns the difference into turn-end, round-start and turn-start events.
 * Scene end: when an encounter is deleted (setting) or when the GM presses "End scene" / calls the API.
 * Long rest: the system's `cosmere-rpg.rest` hook, on the resting user's client.
 */
import { CONDITIONS_BY_ID } from '../data/conditions.js';
import { postLine } from './chat.js';
import { FLAGS, MODES, MODULE_ID, OPTION_KEYS, SYSTEM_ID } from './constants.js';
import { advance, describeDuration, newDuration, parseDurationSpec, phaseIndex } from './logic/durations.js';
import { isEndStance } from './logic/stances.js';
import { conditionIdOf } from './logic/table.js';
import { allActors, conditionMode, featureMode, otherModuleReducesExhaustion, setting, SETTINGS, stanceMode } from './settings.js';
import { endStance } from './stances.js';
import { afflictedTurnEnd } from './triggers.js';
import { actorName, esc, isActiveGM, safe, serial, t } from './util.js';

export function registerDurationHooks() {
    Hooks.on('updateCombat', safe('updateCombat', onUpdateCombat));
    Hooks.on('deleteCombat', safe('deleteCombat', onDeleteCombat));
    Hooks.on(`${SYSTEM_ID}.rest`, safe('rest', onRest));
    Hooks.on('getSceneControlButtons', safe('getSceneControlButtons', addEndSceneButton));
}

/* --- Context --- */

/** Phase of a combatant's turn (fast/slow, PC/NPC). */
function phaseOf(combatant) {
    const speed = combatant?.turnSpeed ?? combatant?.getFlag?.(SYSTEM_ID, 'turnSpeed');
    return phaseIndex({ fast: speed === 'fast', pc: combatant?.actor?.type === 'character' });
}

/** The encounter in progress, with the phase of the current turn (or of the last one, between turns). */
export function combatContext() {
    const combat = game.combat;
    if (!combat?.started) return null;
    const current = combat.turns?.[combat.turn] ?? null;
    const previous = combat.previous?.combatantId ? combat.combatants?.get(combat.previous.combatantId) : null;
    const turn = current ?? previous;
    return { id: combat.id, round: combat.round, phase: turn ? phaseOf(turn) : 0 };
}

/**
 * Build a stored duration for an effect on `actor`.
 * @param {Actor} actor
 * @param {unknown} spec kind, list of kinds or {kinds, days, turnOf}
 * @returns {object | null}
 */
export function buildDuration(actor, spec) {
    const parsed = parseDurationSpec(spec);
    if (!parsed.ok) throw new Error(parsed.error);
    const turnOf = spec?.turnOf?.uuid ?? (typeof spec?.turnOf === 'string' ? spec.turnOf : actor?.uuid ?? null);
    return newDuration(parsed, { turnOf, combat: combatContext() });
}

/** Whether to ask for a duration when a condition is turned on by hand. */
export function shouldAskDuration() {
    if (featureMode(SETTINGS.DURATIONS) === MODES.OFF) return false;
    const ask = setting(SETTINGS.ASK_DURATION, 'combat');
    if (ask === 'always') return true;
    if (ask === 'combat') return !!game.combat?.started;
    return false;
}

/** Readable duration of an effect. */
export function durationText(effect) {
    const state = effect.getFlag(MODULE_ID, FLAGS.DURATION);
    const ownerActor = state?.turnOf ? globalThis.fromUuidSync?.(state.turnOf) : null;
    const owner = ownerActor && ownerActor !== effect.parent ? actorName(ownerActor) : undefined;
    return describeDuration(state, { owner });
}

/* --- Processing --- */

/**
 * Apply an event to every effect with a duration on the given actors.
 * @param {Actor[]} actors
 * @param {object} event
 * @param {{only?: (effect) => boolean}} [options]
 */
export async function dispatch(actors, event, { only } = {}) {
    const mode = featureMode(SETTINGS.DURATIONS);
    if (mode === MODES.OFF) return;
    const seen = new Set();
    for (const actor of actors) {
        if (!actor || seen.has(actor.uuid)) continue;
        seen.add(actor.uuid);
        await serial(actor.uuid, () => dispatchActor(actor, event, mode, only));
    }
}

async function dispatchActor(actor, event, mode, only) {
    const expired = [];
    const updates = [];
    for (const effect of actor.effects?.contents ?? []) {
        const state = effect.getFlag(MODULE_ID, FLAGS.DURATION);
        if (!state?.kinds?.length || (only && !only(effect))) continue;
        const result = advance(state, event);
        if (result.expired) expired.push({ effect, text: durationText(effect) });
        else if (result.changed) updates.push({ _id: effect.id, [`flags.${MODULE_ID}.${FLAGS.DURATION}`]: result.state });
    }
    if (updates.length) await actor.updateEmbeddedDocuments('ActiveEffect', updates);
    if (!expired.length) return;

    if (mode === MODES.REMIND) {
        for (const { effect, text } of expired) {
            await postLine(
                actor,
                t(
                    'chat.wouldExpire',
                    { actor: `<b>${esc(actorName(actor))}</b>`, effect: `<b>${esc(effect.name)}</b>` },
                    "{actor}'s {effect} ends now.",
                ),
                { reminder: `${text}. ${t('chat.wouldExpireHint', null, 'Remove it by hand (durations are in remind-only mode).')}` },
            );
        }
        // Stop tracking so the reminder isn't repeated.
        await actor.updateEmbeddedDocuments(
            'ActiveEffect',
            expired.map(({ effect }) => ({ _id: effect.id, [`flags.${MODULE_ID}.-=${FLAGS.DURATION}`]: null })),
        );
        return;
    }

    // Conditions get their chat line from the delete handler; other effects get one here.
    for (const { effect } of expired) {
        if (conditionIdOf(effect.statuses, CONDITIONS_BY_ID)) continue;
        await postLine(
            actor,
            t('chat.effectExpired', { actor: `<b>${esc(actorName(actor))}</b>`, effect: `<b>${esc(effect.name)}</b>` }, "{actor}'s {effect} has ended."),
        );
    }
    const ids = expired.map(({ effect }) => effect.id).filter((id) => actor.effects.has(id));
    if (ids.length) {
        await actor.deleteEmbeddedDocuments('ActiveEffect', ids, {
            [MODULE_ID]: { [OPTION_KEYS.ENGINE]: { expired: true } },
        });
    }
}

/* --- Events --- */

function combatActors(combat) {
    const actors = [];
    for (const combatant of combat?.combatants ?? []) if (combatant.actor) actors.push(combatant.actor);
    return actors;
}

function turnEvent(type, combat, combatantId, round) {
    const combatant = combat.combatants?.get(combatantId) ?? combat.turns?.find((c) => c.id === combatantId);
    if (!combatant?.actor) return null;
    return { type, combatId: combat.id, round, phase: phaseOf(combatant), actorUuid: combatant.actor.uuid };
}

/** Last turn pointer seen per combat: {round, combatantId}. */
const lastSeen = new Map();

function pointerOf(combat) {
    const combatant = combat.turn == null ? null : combat.turns?.[combat.turn];
    return { round: combat.round ?? 0, combatantId: combatant?.id ?? null };
}

function onUpdateCombat(combat, changed) {
    if (!('turn' in (changed ?? {})) && !('round' in (changed ?? {}))) return;
    if (!isActiveGM()) return;
    const current = pointerOf(combat);
    const prior =
        lastSeen.get(combat.id) ??
        (combat.previous ? { round: combat.previous.round ?? 0, combatantId: combat.previous.combatantId ?? null } : null);
    lastSeen.set(combat.id, current);
    if (!prior) return;
    return onTurnChange(combat, prior, current);
}

async function onTurnChange(combat, prior, current) {
    const actors = combatActors(combat);
    const events = [];
    const turnChanged = prior?.combatantId !== current?.combatantId || prior?.round !== current?.round;
    if (prior?.combatantId && turnChanged) events.push(turnEvent('turnEnd', combat, prior.combatantId, prior.round));
    if ((current?.round ?? 0) > (prior?.round ?? 0)) {
        events.push({ type: 'roundStart', combatId: combat.id, round: current.round });
    }
    if (current?.combatantId && turnChanged) events.push(turnEvent('turnStart', combat, current.combatantId, current.round));
    for (const event of events) {
        if (!event) continue;
        // Afflicted deals its damage at the end of the turn, before effects lasting until then end.
        if (event.type === 'turnEnd') await afflictedTurnEnd(actors.find((a) => a.uuid === event.actorUuid));
        await dispatch(actors, event);
    }
}

async function onDeleteCombat(combat) {
    lastSeen.delete(combat?.id);
    if (!isActiveGM() || !combat?.started) return;
    const actors = combatActors(combat);
    await dispatch(actors, { type: 'combatEnd', combatId: combat.id });
    if (setting(SETTINGS.COMBAT_ENDS_SCENE, true)) await endScene({ actors });
}

async function onRest(actor, restType) {
    if (restType !== 'long' || !actor?.isOwner) return;
    await dispatch([actor], { type: 'longRest' });
    await reduceExhaustion(actor);
}

/**
 * A long rest removes one stack of Exhausted (the system leaves this to the GM). Skipped when Cosmere Automated
 * Actions already does it, so the stack isn't taken twice (or the effect deleted twice).
 */
async function reduceExhaustion(actor) {
    const mode = conditionMode('exhausted');
    if (mode === MODES.OFF || otherModuleReducesExhaustion()) return;
    const effect = actor.effects.find((e) => conditionIdOf(e.statuses, CONDITIONS_BY_ID) === 'exhausted');
    if (!effect) return;
    const stacks = effect.system?.stacks ?? 1;
    if (mode === MODES.REMIND) {
        await postLine(
            actor,
            t('chat.exhaustionRemind', { actor: `<b>${esc(actorName(actor))}</b>` }, '{actor} finished a long rest.'),
            { reminder: t('chat.exhaustionRemindHint', null, 'Exhausted goes down by 1.') },
        );
        return;
    }
    if (stacks > 1) await effect.update({ 'system.stacks': stacks - 1 });
    else await effect.delete({ [MODULE_ID]: { [OPTION_KEYS.ENGINE]: { reason: t('reason.longRest', null, 'long rest') } } });
}

/* --- End of scene --- */

/** Actors of the tokens on the scene being viewed. */
export function sceneActors(scene = globalThis.canvas?.scene) {
    return [...(scene?.tokens ?? [])].map((token) => token.actor).filter(Boolean);
}

/**
 * End the scene for some actors: effects that last until the end of the scene (and leftover combat durations)
 * end, stances end, per-scene uses recharge. Each part follows its own setting.
 * @param {{actors?: Actor[]}} [options] default: the actors on the viewed scene
 */
export async function endScene({ actors } = {}) {
    const list = [...new Map((actors ?? sceneActors()).filter(Boolean).map((a) => [a.uuid, a])).values()];
    await dispatch(list, { type: 'sceneEnd' });

    const stances = stanceMode();
    const recharge = featureMode(SETTINGS.SCENE_RECHARGE);
    for (const actor of list) {
        if (!actor.isOwner) continue;
        const mode = actor.getFlag(SYSTEM_ID, 'mode.stance');
        if (mode && !isEndStance(mode)) {
            if (stances === MODES.FULL) await endStance(actor);
            else if (stances === MODES.REMIND) {
                await postLine(actor, t('chat.stanceSceneEnd', { actor: `<b>${esc(actorName(actor))}</b>` }, "{actor}'s stance ends with the scene."));
            }
        }
        if (recharge !== MODES.OFF) await rechargeSceneUses(actor, recharge);
    }
}

async function rechargeSceneUses(actor, mode) {
    const names = [];
    for (const item of actor.items ?? []) {
        const resources = item.system?.resources;
        if (!resources || typeof item.recharge !== 'function') continue;
        const keys = Object.entries(resources)
            .filter(([, r]) => r?.recharge === 'per_scene' && Number.isFinite(r.max) && (r.value ?? 0) < r.max)
            .map(([key]) => key);
        if (!keys.length) continue;
        names.push(item.name);
        if (mode === MODES.FULL) await item.recharge(keys);
    }
    if (!names.length) return;
    await postLine(
        actor,
        mode === MODES.FULL
            ? t('chat.recharged', { actor: `<b>${esc(actorName(actor))}</b>`, items: esc(names.join(', ')) }, '{actor} recharges {items}.')
            : t('chat.rechargeRemind', { actor: `<b>${esc(actorName(actor))}</b>`, items: esc(names.join(', ')) }, '{actor} can recharge {items} (end of scene).'),
    );
}

function addEndSceneButton(controls) {
    if (!game.user?.isGM) return;
    const tokens = controls?.tokens ?? (Array.isArray(controls) ? controls.find((c) => c.name === 'token') : null);
    if (!tokens?.tools) return;
    const tool = {
        name: 'ep-end-scene',
        title: t('controls.endScene', null, 'End scene (EP Cosmere Automations)'),
        icon: 'fa-solid fa-flag-checkered',
        button: true,
        visible: true,
        order: 99,
        onChange: () => confirmEndScene(),
        onClick: () => confirmEndScene(),
    };
    if (Array.isArray(tokens.tools)) tokens.tools.push(tool);
    else tokens.tools[tool.name] = tool;
}

let confirming = false;
async function confirmEndScene() {
    if (confirming) return; // onChange and onClick may both fire
    confirming = true;
    try {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: t('dialog.endSceneTitle', null, 'End scene') },
            content: `<p>${esc(
                t(
                    'dialog.endSceneBody',
                    null,
                    'End the scene for the tokens on this scene? Effects that last until the end of the scene end, stances end and per-scene uses recharge, as the module settings say.',
                ),
            )}</p>`,
            rejectClose: false,
        });
        if (ok) await endScene();
    } finally {
        confirming = false;
    }
}

/* --- API helpers --- */

/**
 * Days pass (for effects measured in days).
 * @param {number} n
 * @param {{actors?: Actor[]}} [options] default: every actor
 */
export function advanceDays(n = 1, { actors } = {}) {
    return dispatch(actors ?? allActors(), { type: 'days', n });
}

/**
 * Use up an effect that lasts "until used".
 * @param {ActiveEffect} effect
 */
export function useUp(effect) {
    const actor = effect?.parent;
    if (!actor) return null;
    return dispatch([actor], { type: 'used' }, { only: (e) => e.id === effect.id });
}

/**
 * Set or replace an effect's duration.
 * @param {ActiveEffect} effect
 * @param {unknown} spec
 */
export async function setDuration(effect, spec) {
    const state = buildDuration(effect.parent, spec);
    if (!state) return effect.update({ [`flags.${MODULE_ID}.-=${FLAGS.DURATION}`]: null });
    return effect.setFlag(MODULE_ID, FLAGS.DURATION, state);
}

