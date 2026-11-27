/**
 * Triggers: rules that act at a moment rather than change a number.
 * - Afflicted: at the end of each of its turns, each instance deals its damage (resolved one by one, through the
 *   system's `applyDamage`, which handles deflect and immunities and posts its own damage card).
 * - Surprised: it cannot take a fast turn. Its combatants are kept on slow; a boss's extra fast turn is the system's
 *   (a virtual copy of the combatant), so for a boss there is only a reminder.
 * Both run on the active GM's client, which may change any actor and combatant. Each follows its condition's setting.
 */
import { CONDITIONS_BY_ID } from '../data/conditions.js';
import { postLine } from './chat.js';
import { FLAGS, MODES, MODULE_ID, SYSTEM_ID } from './constants.js';
import { activeConditions } from './mechanics.js';
import { conditionIdOf } from './logic/table.js';
import { conditionMode } from './settings.js';
import { actorName, esc, isActiveGM, safe, systemChoices, t } from './util.js';

export function registerTriggerHooks() {
    Hooks.on('createActiveEffect', safe('createActiveEffect (surprised)', onCreateEffect));
    Hooks.on('createCombatant', safe('createCombatant (surprised)', (combatant) => keepSlow(combatant)));
    Hooks.on('updateCombatant', safe('updateCombatant (surprised)', onUpdateCombatant));
}

/* --- Afflicted --- */

/**
 * End of an actor's turn: each Afflicted instance deals its damage. Called by the duration layer before it ends
 * effects that last until the end of the turn.
 * @param {Actor} actor
 */
export async function afflictedTurnEnd(actor) {
    if (!actor || !isActiveGM()) return;
    const mode = conditionMode('afflicted');
    if (mode === MODES.OFF) return;
    const instances = activeConditions(actor)
        .filter((c) => c.id === 'afflicted')
        .map((c) => ({ effect: c.effect, value: c.effect.getFlag(MODULE_ID, FLAGS.VALUE) }))
        .filter(({ value }) => value && Number(value.amount) > 0);
    if (!instances.length) return;

    const typeLabels = systemChoices().damageTypes;
    for (const { effect, value } of instances) {
        const amount = Math.floor(Number(value.amount));
        const typeLabel = typeLabels[value.type] ?? value.type ?? '';
        const data = { actor: `<b>${esc(actorName(actor))}</b>`, amount, type: esc(typeLabel), effect: `<b>${esc(effect.name)}</b>` };
        if (mode === MODES.REMIND) {
            await postLine(actor, t('chat.afflictedRemind', data, "{actor}'s {effect} deals its damage now (end of its turn)."), {
                reminder: t('chat.afflictedRemindHint', { amount, type: typeLabel }, 'Apply {amount} {type} damage (Afflicted is in remind-only mode).'),
            });
            continue;
        }
        await postLine(actor, t('chat.afflictedDamage', data, '{actor} takes {amount} {type} damage from {effect}.'));
        await actor.applyDamage([{ amount, type: value.type }]);
    }
}

/* --- Surprised: no fast turn --- */

function isSurprised(actor) {
    return activeConditions(actor).some((c) => c.id === 'surprised');
}

function onCreateEffect(effect) {
    if (!isActiveGM() || conditionIdOf(effect.statuses, CONDITIONS_BY_ID) !== 'surprised') return;
    const actor = effect.parent;
    if (!(actor instanceof Actor)) return;
    return keepSlowFor(actor);
}

function onUpdateCombatant(combatant, changed) {
    if (!foundry.utils.hasProperty(changed, `flags.${SYSTEM_ID}.turnSpeed`)) return;
    return keepSlow(combatant);
}

/** Every combatant of the actor, in every encounter. */
async function keepSlowFor(actor) {
    for (const combat of game.combats ?? []) {
        for (const combatant of combat.combatants ?? []) {
            if (combatant.actor === actor || (combatant.actor && combatant.actor.uuid === actor.uuid)) await keepSlow(combatant);
        }
    }
}

/**
 * A Surprised actor's combatant on a fast turn goes to slow (full), or gets a reminder (remind, and bosses).
 * @param {Combatant} combatant
 */
export async function keepSlow(combatant) {
    if (!isActiveGM()) return;
    const actor = combatant?.actor;
    if (!actor || !isSurprised(actor)) return;
    const mode = conditionMode('surprised');
    if (mode === MODES.OFF) return;
    const speed = combatant.turnSpeed ?? combatant.getFlag?.(SYSTEM_ID, 'turnSpeed');
    const isBoss = !!combatant.isBoss;
    if (speed !== 'fast' && !isBoss) return;

    const name = `<b>${esc(actorName(actor))}</b>`;
    if (mode === MODES.FULL && !isBoss) {
        await combatant.setFlag(SYSTEM_ID, 'turnSpeed', 'slow');
        await postLine(actor, t('chat.surprisedSlow', { actor: name }, '{actor} is Surprised and cannot take a fast turn: moved to a slow turn.'));
        return;
    }
    await postLine(actor, t('chat.surprisedRemind', { actor: name }, '{actor} is Surprised and cannot take a fast turn.'), {
        reminder: isBoss
            ? t('chat.surprisedBossHint', null, 'Skip its fast turn (a boss keeps its slow turn).')
            : t('chat.surprisedRemindHint', null, 'Move it to a slow turn (Surprised is in remind-only mode).'),
    });
}
