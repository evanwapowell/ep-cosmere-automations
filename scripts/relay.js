/**
 * GM relay: work a player's client may not do itself, done by the active GM's client on request.
 * Today: using up a situational effect on an actor the player doesn't own (their attack uses up the target's
 * Dodging). Each request is checked on the GM's side; nothing else is accepted.
 */
import { MODULE_ID, OPTION_KEYS } from './constants.js';
import { rulesOf } from './rules.js';
import { isActiveGM, safe, t, warn } from './util.js';

const CHANNEL = `module.${MODULE_ID}`;

export function registerRelay() {
    Hooks.once('ready', () => game.socket?.on(CHANNEL, safe('relay', onMessage)));
}

/** Whether an effect is one the relay may use up: one with a roll rule that is used up by a test. */
function isConsumable(effect) {
    return !!effect && !!rulesOf(effect).rolls?.some((rule) => rule.consume);
}

async function onMessage(message) {
    if (!isActiveGM() || message?.type !== 'consume') return;
    await consumeLocally(message.actorUuid, message.effectId);
}

async function consumeLocally(actorUuid, effectId) {
    const actor = globalThis.fromUuidSync?.(actorUuid);
    const effect = actor?.effects?.get(effectId);
    if (!effect || !isConsumable(effect)) return false;
    await effect.delete({ [MODULE_ID]: { [OPTION_KEYS.ENGINE]: { reason: t('reason.used', null, 'used') } } });
    return true;
}

/**
 * Use up a situational effect, through the GM when this user can't edit its actor.
 * @param {string} actorUuid
 * @param {string} effectId
 */
export async function consumeEffect(actorUuid, effectId) {
    const actor = globalThis.fromUuidSync?.(actorUuid);
    const effect = actor?.effects?.get(effectId);
    if (!effect) return false;
    if (effect.isOwner || isActiveGM()) return consumeLocally(actorUuid, effectId);
    if (!game.users?.activeGM) {
        warn('No GM is connected to remove a used effect:', effect.name);
        ui.notifications?.warn(
            t('notify.noGM', { effect: effect.name }, 'No GM is connected to remove {effect}; remove it by hand.'),
        );
        return false;
    }
    game.socket.emit(CHANNEL, { type: 'consume', actorUuid, effectId, userId: game.user.id });
    return true;
}
