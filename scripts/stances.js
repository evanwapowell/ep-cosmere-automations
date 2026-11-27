/**
 * Stances: make using a stance actually switch it on, and show it on the token.
 * Builds on the system's modality (`actor.setMode`), which enables the chosen talent's effects and
 * disables the other stances' effects.
 *
 * Two ways a stance gets used, depending on the data:
 * - an action the stance talent grants (e.g. `stone-stance`): the system's `useItem` hook, then we find the talent;
 * - the talent itself, listed as usable on the sheet (the Stormlight Handbook talents, seen live 2026-11-25): the
 *   system's `item.use()` returns null for anything that isn't an action, so `use` is wrapped for mode talents.
 *
 * Ending a stance never unsets the flag: in cosmere-rpg 3.1.2 the system's `preUpdateActor` handler reads
 * `{mode: {'-=stance': null}}` as a modality named "-=stance" and the update throws (seen live 2026-11-25).
 * `actor.setMode('stance', null)` clears it instead and disables every stance effect.
 */
import { postLine } from './chat.js';
import { FLAGS, MODES, MODULE_ID, STANCE_STATUS, SYSTEM_ID } from './constants.js';
import { findModalityTalent, isEndStance, talentMode } from './logic/stances.js';
import { stanceMode } from './settings.js';
import { actorName, createOwnEffects, esc, safe, serial, t } from './util.js';

const WRAPPED = Symbol('ep-cosmere-automations.talentUse');

export function registerStanceHooks() {
    Hooks.on(`${SYSTEM_ID}.useItem`, safe('useItem (stances)', onUseItem));
    Hooks.on('updateActor', safe('updateActor (stances)', onUpdateActor));
    Hooks.once('setup', safe('setup (stances)', () => wrapTalentUse()));
}

/** The actor's talent for a modality's current mode, if any. */
function modeTalent(actor, modality, modeId) {
    if (!modeId) return null;
    return (
        actor.items.find((i) => i.type === 'talent' && i.system?.modality === modality && i.system?.id === modeId) ?? null
    );
}

async function onUseItem(item) {
    const actor = item?.actor;
    if (!actor) return;
    const talent = findModalityTalent(item, actor.items.contents ?? [...actor.items]);
    if (talent) await enterMode(actor, talent);
}

/**
 * Switch an actor into a modality talent's mode, following the stance setting.
 * @param {Actor} actor
 * @param {Item} talent a talent with `system.modality` and `system.id`
 * @returns {Promise<boolean>} whether the module handled it (false when stances are off or the user can't)
 */
export async function enterMode(actor, talent) {
    const mode = stanceMode();
    if (mode === MODES.OFF || !actor?.isOwner) return false;
    const modality = talent.system.modality;

    if (mode === MODES.REMIND) {
        if (modality !== 'stance') return false;
        await postLine(
            actor,
            t(
                'chat.stanceRemind',
                { actor: `<b>${esc(actorName(actor))}</b>`, stance: `<b>${esc(talent.name)}</b>` },
                '{actor} takes {stance}.',
            ),
            { reminder: t('chat.stanceRemindHint', null, "Its effects are not switched on automatically (stances are in remind-only mode).") },
        );
        return true;
    }

    if (actor.getFlag(SYSTEM_ID, `mode.${modality}`) === talent.system.id) return true; // already in it
    await actor.setMode(modality, talent.system.id);
    return true;
}

/**
 * Using a mode talent itself enters its mode. Only talents are intercepted (the system returns null for them
 * anyway); everything else goes to the system's `use` unchanged.
 * @param {typeof Item} [cls] the system's item class (default `CONFIG.Item.documentClass`)
 */
export function wrapTalentUse(cls = globalThis.CONFIG?.Item?.documentClass) {
    const original = cls?.prototype?.use;
    if (typeof original !== 'function') {
        console.warn(`${MODULE_ID} | Item.use not found; using a stance talent from the sheet will not enter the stance`);
        return false;
    }
    if (original[WRAPPED]) return true;
    const wrapped = async function (options = {}, ...rest) {
        try {
            if (talentMode(this)) {
                const actor = options?.actor ?? this.actor;
                if (actor && (await enterMode(actor, this))) return null;
            }
        } catch (err) {
            console.error(`${MODULE_ID} | entering a stance from its talent failed`, err);
        }
        return original.call(this, options, ...rest);
    };
    wrapped[WRAPPED] = true;
    cls.prototype.use = wrapped;
    return true;
}

function onUpdateActor(actor, changed, options, userId) {
    if (userId !== game.user.id) return;
    // Any change to the system's flags may be a stance change: syncing is idempotent.
    if (!foundry.utils.hasProperty(changed, `flags.${SYSTEM_ID}`)) return;
    return syncStanceMarker(actor);
}

/** The marker effect that shows the current stance on the token. */
export function stanceMarker(actor) {
    return actor.effects.find((e) => e.getFlag(MODULE_ID, FLAGS.STANCE_MARKER) !== undefined) ?? null;
}

/**
 * Make the marker match the actor's stance: one marker for the current stance, none when there is no stance
 * (or End Stance). Runs one at a time per actor, so the hook and a direct call don't both create or delete it.
 */
export function syncStanceMarker(actor) {
    if (stanceMode() !== MODES.FULL) return Promise.resolve();
    return serial(`${actor.uuid}:stance`, () => syncNow(actor));
}

async function syncNow(actor) {
    const modeId = actor.getFlag(SYSTEM_ID, 'mode.stance');
    const talent = isEndStance(modeId) ? null : modeTalent(actor, 'stance', modeId);
    const marker = stanceMarker(actor);

    if (!talent) {
        if (!marker) return;
        await marker.delete();
        await postLine(actor, t('chat.stanceEnded', { actor: `<b>${esc(actorName(actor))}</b>` }, '{actor} is no longer in a stance.'));
        return;
    }
    if (marker?.getFlag(MODULE_ID, FLAGS.STANCE_MARKER) === talent.system.id) return;

    const data = {
        name: t('effect.stance', { stance: talent.name }, 'Stance: {stance}'),
        img: talent.img,
        statuses: [STANCE_STATUS],
        description: talent.system?.description?.short ?? '',
        flags: { [MODULE_ID]: { [FLAGS.STANCE_MARKER]: talent.system.id } },
    };
    if (marker) await marker.update(data);
    else await createOwnEffects(actor, [data]);
    await postLine(
        actor,
        t(
            'chat.stanceStarted',
            { actor: `<b>${esc(actorName(actor))}</b>`, stance: `<b>${esc(talent.name)}</b>` },
            '{actor} takes {stance}.',
        ),
    );
}

/**
 * End the actor's stance: switch to End Stance if the actor has it (a talent or an action with the stance
 * modality), else clear the mode with `setMode('stance', null)`, which also disables every stance effect.
 */
export async function endStance(actor) {
    const endItem = actor.items.find((i) => i.system?.modality === 'stance' && isEndStance(i.system?.id));
    await actor.setMode('stance', endItem ? endItem.system.id : null);
    return syncStanceMarker(actor);
}
