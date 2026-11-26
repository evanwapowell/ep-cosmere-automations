/**
 * Stances: make using a stance's action actually switch the stance on, and show it on the token.
 * Builds on the system's modality (`actor.setMode`), which enables the chosen talent's effects and
 * disables the other stances' effects.
 */
import { postLine } from './chat.js';
import { FLAGS, MODES, MODULE_ID, STANCE_STATUS, SYSTEM_ID } from './constants.js';
import { findModalityTalent, isEndStance } from './logic/stances.js';
import { stanceMode } from './settings.js';
import { actorName, esc, safe, t } from './util.js';

export function registerStanceHooks() {
    Hooks.on(`${SYSTEM_ID}.useItem`, safe('useItem (stances)', onUseItem));
    Hooks.on('updateActor', safe('updateActor (stances)', onUpdateActor));
}

/** The actor's talent for a modality's current mode, if any. */
function modeTalent(actor, modality, modeId) {
    if (!modeId) return null;
    return (
        actor.items.find((i) => i.type === 'talent' && i.system?.modality === modality && i.system?.id === modeId) ?? null
    );
}

async function onUseItem(item) {
    const mode = stanceMode();
    if (mode === MODES.OFF) return;
    const actor = item?.actor;
    if (!actor || !actor.isOwner) return;

    const talent = findModalityTalent(item, actor.items.contents ?? [...actor.items]);
    if (!talent) return;
    const modality = talent.system.modality;

    if (mode === MODES.REMIND) {
        if (modality !== 'stance') return;
        await postLine(
            actor,
            t(
                'chat.stanceRemind',
                { actor: `<b>${esc(actorName(actor))}</b>`, stance: `<b>${esc(talent.name)}</b>` },
                '{actor} takes {stance}.',
            ),
            { reminder: t('chat.stanceRemindHint', null, "Its effects are not switched on automatically (stances are in remind-only mode).") },
        );
        return;
    }

    if (actor.getFlag(SYSTEM_ID, `mode.${modality}`) === talent.system.id) return; // already in it
    await actor.setMode(modality, talent.system.id);
}

function onUpdateActor(actor, changed, options, userId) {
    if (userId !== game.user.id) return;
    // Any change to the system's flags may be a stance change (set, or removed with `-=`): syncing is idempotent.
    if (!foundry.utils.hasProperty(changed, `flags.${SYSTEM_ID}`)) return;
    return syncStanceMarker(actor);
}

/** The marker effect that shows the current stance on the token. */
export function stanceMarker(actor) {
    return actor.effects.find((e) => e.getFlag(MODULE_ID, FLAGS.STANCE_MARKER) !== undefined) ?? null;
}

/**
 * Make the marker match the actor's stance: one marker for the current stance, none when there is no stance
 * (or End Stance).
 */
export async function syncStanceMarker(actor) {
    if (stanceMode() !== MODES.FULL) return;
    const modeId = actor.getFlag(SYSTEM_ID, 'mode.stance');
    const talent = isEndStance(modeId) ? null : modeTalent(actor, 'stance', modeId);
    const marker = stanceMarker(actor);

    if (!talent) {
        if (marker) await marker.delete();
        if (marker) {
            await postLine(
                actor,
                t('chat.stanceEnded', { actor: `<b>${esc(actorName(actor))}</b>` }, '{actor} is no longer in a stance.'),
            );
        }
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
    else await actor.createEmbeddedDocuments('ActiveEffect', [data]);
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
 * End the actor's stance: switch to the End Stance talent if it has one, else clear the mode and
 * disable every stance talent's effects (the system's own clearMode filters on the wrong field).
 */
export async function endStance(actor) {
    const endTalent = actor.items.find(
        (i) => i.type === 'talent' && i.system?.modality === 'stance' && isEndStance(i.system?.id),
    );
    if (endTalent) return actor.setMode('stance', endTalent.system.id);

    await actor.unsetFlag(SYSTEM_ID, 'mode.stance');
    const updates = [];
    for (const item of actor.items) {
        if (item.type !== 'talent' || item.system?.modality !== 'stance') continue;
        for (const effect of item.effects) if (!effect.disabled) updates.push(effect.update({ disabled: true }));
    }
    await Promise.all(updates);
    return syncStanceMarker(actor);
}
