/**
 * Situational effects from actions: Dodge → Dodging, Brace → Bracing, Gain Advantage → Advantage gained
 * (after the player confirms the test succeeded). The roll layer reads them; durations and the end triggers
 * (bearer attacks or moves) remove them.
 */
import { SITUATIONAL, SITUATIONAL_BY_ID, situationalStatus } from '../data/situational.js';
import { postLine } from './chat.js';
import { FLAGS, MODES, MODULE_ID, OPTION_KEYS, SYSTEM_ID } from './constants.js';
import { buildDuration } from './durations.js';
import { featureMode, SETTINGS } from './settings.js';
import { actorName, createOwnEffects, esc, safe, t } from './util.js';

const BUTTON = `${MODULE_ID}-grant`;

export function registerSituationalHooks() {
    Hooks.on(`${SYSTEM_ID}.useItem`, safe('useItem (situational)', onUseItem));
    Hooks.on('updateToken', safe('updateToken (situational)', onUpdateToken));
}

/** The situational effects on an actor: [{id, effectId, value, effect}]. */
export function situationalEffects(actor) {
    const list = [];
    for (const effect of actor?.effects ?? []) {
        if (effect.disabled) continue;
        const id = effect.getFlag?.(MODULE_ID, FLAGS.SITUATIONAL);
        if (id && SITUATIONAL_BY_ID[id]) list.push({ id, effectId: effect.id, value: effect.getFlag(MODULE_ID, FLAGS.VALUE) ?? null, effect });
    }
    return list;
}

/** The single targeted token's actor, or null (none, several, or the user's own actor). */
export function singleTarget(self) {
    const targets = [...(game.user?.targets ?? [])];
    if (targets.length !== 1) return null;
    const actor = targets[0]?.actor ?? null;
    return actor && actor !== self ? actor : null;
}

/**
 * Put a situational effect on an actor. Replaces one of the same kind (for the same target).
 * @param {Actor} actor
 * @param {string} id situational id
 * @param {{target?: Actor | null, img?: string, duration?: unknown}} [options]
 */
export async function createSituational(actor, id, { target = null, img, duration } = {}) {
    const entry = SITUATIONAL_BY_ID[id];
    if (!entry || entry.stance) throw new Error(`Unknown situational effect "${id}"`);
    if (entry.needsTarget && !target) throw new Error(`${entry.name} needs a target`);
    const value = target ? { targetUuid: target.uuid, targetName: actorName(target) } : null;

    const old = situationalEffects(actor).filter((s) => s.id === id && (!entry.needsTarget || s.value?.targetUuid === value?.targetUuid));
    if (old.length) {
        await actor.deleteEmbeddedDocuments(
            'ActiveEffect',
            old.map((s) => s.effectId),
            { [MODULE_ID]: { [OPTION_KEYS.ENGINE]: { reason: '' } } },
        );
    }

    const state = buildDuration(actor, duration !== undefined ? duration : entry.duration);
    const data = {
        name: value ? `${entry.name}: ${value.targetName}` : entry.name,
        img: img ?? entry.img,
        statuses: [situationalStatus(id)],
        description: entry.summary,
        flags: { [MODULE_ID]: { [FLAGS.SITUATIONAL]: id, [FLAGS.VALUE]: value, ...(state ? { [FLAGS.DURATION]: state } : {}) } },
    };
    const [created] = await createOwnEffects(actor, [data]);
    await postLine(
        actor,
        t('chat.situational', { actor: `<b>${esc(actorName(actor))}</b>`, effect: `<b>${esc(data.name)}</b>` }, '{actor}: {effect}.'),
        { detail: entry.summary },
    );
    return created;
}

/**
 * End the situational effects an event ends ('attack' or 'move') on an actor this client may edit.
 * @param {Actor} actor
 * @param {'attack' | 'move'} trigger
 */
export async function endOn(actor, trigger) {
    if (!actor?.isOwner) return;
    const ending = situationalEffects(actor).filter((s) => SITUATIONAL_BY_ID[s.id].endsWhen?.includes(trigger));
    if (!ending.length) return;
    const reason = trigger === 'attack' ? t('reason.attacked', null, 'it attacked') : t('reason.moved', null, 'it moved');
    await actor.deleteEmbeddedDocuments(
        'ActiveEffect',
        ending.map((s) => s.effectId),
        { [MODULE_ID]: { [OPTION_KEYS.ENGINE]: { reason } } },
    );
    await postLine(
        actor,
        t(
            'chat.situationalEnded',
            {
                actor: `<b>${esc(actorName(actor))}</b>`,
                effect: `<b>${esc(ending.map((s) => s.effect.name).join(', '))}</b>`,
                reason: esc(reason),
            },
            "{actor}'s {effect} ends ({reason}).",
        ),
    );
}

async function onUseItem(item) {
    const mode = featureMode(SETTINGS.ACTION_EFFECTS);
    if (mode === MODES.OFF) return;
    const actionId = item?.system?.id;
    const entry = SITUATIONAL.find((e) => e.action && e.action === actionId);
    const actor = item?.actor;
    if (!entry || !actor?.isOwner) return;

    const target = entry.needsTarget ? singleTarget(actor) : null;
    if (entry.needsTarget && !target) {
        ui.notifications?.info(t('notify.needsTarget', { action: item.name }, '{action}: target one enemy to track the advantage.'));
        return;
    }

    if (mode === MODES.REMIND) {
        const name = target ? `${entry.name}: ${actorName(target)}` : entry.name;
        await postLine(
            actor,
            t('chat.situationalRemind', { actor: `<b>${esc(actorName(actor))}</b>`, effect: `<b>${esc(name)}</b>` }, '{actor}: {effect}.'),
            { reminder: entry.summary },
        );
        return;
    }

    if (entry.needsSuccess) return postGrantCard(actor, entry, target, item);
    return createSituational(actor, entry.id, { target, img: item.img });
}

/* --- Gain Advantage: a card with a "succeeded" button --- */

async function postGrantCard(actor, entry, target, item) {
    const label = t('chat.grantButton', null, 'The test succeeded');
    const content = `<div class="${MODULE_ID}-line"><p>${esc(
        t('chat.grantAsk', { actor: actorName(actor), target: actorName(target) }, '{actor} tries to gain the advantage over {target}.'),
    )}</p><button type="button" class="${BUTTON}">${esc(label)}</button></div>`;
    return ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker({ actor }),
        flags: {
            [MODULE_ID]: {
                grant: { id: entry.id, actorUuid: actor.uuid, targetUuid: target.uuid, img: item.img, used: false },
            },
        },
    });
}

/**
 * Wire the "succeeded" button on a rendered card. Called from the chat render hook.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
export function activateGrantButton(message, html) {
    const grant = message?.getFlag?.(MODULE_ID, 'grant');
    const button = html?.querySelector?.(`button.${BUTTON}`);
    if (!grant || !button) return;
    const actor = globalThis.fromUuidSync?.(grant.actorUuid);
    if (grant.used || !actor?.isOwner) {
        button.disabled = true;
        return;
    }
    button.addEventListener('click', async (event) => {
        event.preventDefault();
        button.disabled = true;
        const target = globalThis.fromUuidSync?.(grant.targetUuid);
        if (!target) return;
        await createSituational(actor, grant.id, { target, img: grant.img });
        if (message.isOwner) await message.setFlag(MODULE_ID, 'grant', { ...grant, used: true });
    });
}

function onUpdateToken(token, changes, options, userId) {
    if (userId !== game.user.id) return;
    if (!('x' in (changes ?? {})) && !('y' in (changes ?? {}))) return;
    return endOn(token.actor, 'move');
}
