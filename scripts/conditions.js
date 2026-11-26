/**
 * Layer 5: links, sources, values and chat lines, for conditions created or deleted by any path
 * (token HUD, sheet, API, the engine itself). Handlers run on the client of the user who made the change,
 * who has permission on the actor.
 */
import { CONDITIONS_BY_ID } from '../data/conditions.js';
import { postLine } from './chat.js';
import { FLAGS, MODES, MODULE_ID, OPTION_KEYS } from './constants.js';
import {
    addSource,
    describeSources,
    effectKey,
    isSourceGone,
    MANUAL,
    planSourceRemoval,
    readSources,
} from './logic/sources.js';
import { conditionIdOf } from './logic/table.js';
import { instanceId } from './logic/values.js';
import { buildDuration, durationText, shouldAskDuration } from './durations.js';
import { conditionMode, engineEnabled, featureMode, SETTINGS } from './settings.js';
import { actorName, esc, safe, serial, statusLabel, t } from './util.js';
import { askDetails } from './values.js';

export function registerConditionHooks() {
    Hooks.on('createActiveEffect', safe('createActiveEffect', onCreate));
    Hooks.on('deleteActiveEffect', safe('deleteActiveEffect', onDelete));
    // A condition caused by an item (an injury, via the API's `source`) ends with the item.
    Hooks.on(
        'deleteItem',
        safe('deleteItem', (item, options, userId) => {
            if (userId !== game.user.id || !engineEnabled()) return;
            if (item.parent instanceof Actor) return cleanupSources(item.parent, item.name);
        }),
    );
}

/** The condition effects on an actor (enabled or not), optionally only one id. */
export function conditionEffects(actor, id) {
    return (actor?.effects?.contents ?? [...(actor?.effects ?? [])]).filter((effect) => {
        const cid = conditionIdOf(effect.statuses, CONDITIONS_BY_ID);
        return cid && (!id || cid === id);
    });
}

function storedSources(effect) {
    return effect.getFlag(MODULE_ID, FLAGS.SOURCES);
}

function engineOptions(reason) {
    return { [MODULE_ID]: { [OPTION_KEYS.ENGINE]: { reason: reason ?? '' } } };
}

/**
 * Create a condition effect on an actor through the system's own status data.
 * @param {Actor} actor
 * @param {string} id
 * @param {{value?: object, sources?: {key: string, label: string}[], stacks?: number, extraInstance?: boolean,
 *   duration?: object | null, reason?: string}} [options] duration: a stored duration state (null: none)
 * @returns {Promise<ActiveEffect | null>}
 */
export async function createCondition(actor, id, { value, sources, stacks, extraInstance, duration, reason } = {}) {
    if (actor?.system?.immunities?.condition?.[id]) {
        ui.notifications.warn(
            t('notify.immune', { actor: actorName(actor), condition: statusLabel(id) }, '{actor} is immune to {condition}.'),
        );
        return null;
    }
    const cls = CONFIG.ActiveEffect.documentClass;
    const template = await cls.fromStatusEffect(id);
    const data = template.toObject();
    if (extraInstance) data._id = instanceId(id, () => foundry.utils.randomID(16));
    if (stacks) foundry.utils.setProperty(data, 'system.stacks', stacks);
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.${FLAGS.SOURCES}`, sources ?? [{ ...MANUAL }]);
    if (value) foundry.utils.setProperty(data, `flags.${MODULE_ID}.${FLAGS.VALUE}`, value);
    if (duration) foundry.utils.setProperty(data, `flags.${MODULE_ID}.${FLAGS.DURATION}`, duration);
    return cls.create(data, { parent: actor, keepId: true, ...engineOptions(reason) });
}

/**
 * Make sure a linked condition is on the actor, with `source` among its sources.
 * A condition already there without our flags was applied by hand: it keeps a manual source.
 */
async function ensureLinked(actor, id, source) {
    const existing = conditionEffects(actor, id)[0];
    if (!existing) return createCondition(actor, id, { sources: [source], reason: source.label });
    const current = readSources(storedSources(existing));
    const next = addSource(current, source);
    if (next.length !== current.length || !Array.isArray(storedSources(existing))) {
        await existing.setFlag(MODULE_ID, FLAGS.SOURCES, next);
    }
    return existing;
}

async function onCreate(effect, options, userId) {
    if (userId !== game.user.id || !engineEnabled()) return;
    const actor = effect.parent;
    if (!(actor instanceof Actor)) return;
    const id = conditionIdOf(effect.statuses, CONDITIONS_BY_ID);
    if (!id) return;
    const mode = conditionMode(id);
    if (mode === MODES.OFF) return;
    const entry = CONDITIONS_BY_ID[id];

    // Value and duration first, so the chat line can show them. The engine and the API set their own.
    const byEngine = !!options?.[MODULE_ID]?.[OPTION_KEYS.ENGINE];
    const askValue = !!entry.value && !effect.getFlag(MODULE_ID, FLAGS.VALUE);
    const hasDuration = effect.getFlag(MODULE_ID, FLAGS.DURATION) != null;
    const askDuration = !byEngine && !hasDuration && shouldAskDuration();
    if (askValue || askDuration) {
        await askDetails(effect, id, actorName(actor), { askValue, askDuration });
    } else if (!byEngine && !hasDuration && entry.duration && featureMode(SETTINGS.DURATIONS) !== MODES.OFF) {
        const duration = buildDuration(actor, entry.duration);
        if (duration) await effect.setFlag(MODULE_ID, FLAGS.DURATION, duration);
    }
    if (!actor.effects.has(effect.id)) return; // removed while the dialog was open

    const from = describeSources(readSources(storedSources(effect)));
    const links = (entry.links ?? []).map((link) => statusLabel(link, CONDITIONS_BY_ID[link]?.name));
    let reminder;
    if (mode === MODES.REMIND) {
        reminder = entry.summary;
        if (links.length) reminder += ` ${t('chat.alsoApply', { list: links.join(', ') }, 'Also apply: {list}.')}`;
    }
    await postLine(
        actor,
        t(
            from ? 'chat.startedFrom' : 'chat.started',
            { actor: `<b>${esc(actorName(actor))}</b>`, condition: `<b>${esc(effect.name)}</b>`, source: esc(from) },
            from ? '{actor} is now {condition} (from {source}).' : '{actor} is now {condition}.',
        ),
        { reminder, detail: effect.getFlag(MODULE_ID, FLAGS.DURATION) ? durationText(effect) : undefined },
    );

    if (mode === MODES.FULL && entry.links?.length) {
        await serial(actor.uuid, async () => {
            for (const link of entry.links) {
                if (!actor.effects.has(effect.id)) break; // removed meanwhile
                await ensureLinked(actor, link, { key: effectKey(effect.id), label: effect.name });
            }
        });
    }
}

/**
 * Drop sources that no longer exist on the actor; end conditions left without one.
 * Safe to run any number of times: it only looks at what is present now.
 * @param {Actor} actor
 * @param {string} [reason] shown in the chat line of conditions that end
 */
export function cleanupSources(actor, reason) {
    return serial(actor.uuid, async () => {
        const effects = actor.effects?.contents ?? [];
        const present = {
            effectIds: new Set(effects.map((e) => e.id)),
            itemIds: new Set((actor.items?.contents ?? []).map((i) => i.id)),
        };
        const plan = planSourceRemoval(
            effects.map((e) => ({ id: e.id, sources: storedSources(e) })),
            (key) => isSourceGone(key, present),
        );
        const deletes = plan.filter((p) => p.action === 'delete' && actor.effects.has(p.id)).map((p) => p.id);
        const updates = plan
            .filter((p) => p.action === 'update' && actor.effects.has(p.id))
            .map((p) => ({ _id: p.id, [`flags.${MODULE_ID}.${FLAGS.SOURCES}`]: p.sources }));
        if (updates.length) await actor.updateEmbeddedDocuments('ActiveEffect', updates);
        if (deletes.length) await actor.deleteEmbeddedDocuments('ActiveEffect', deletes, engineOptions(reason));
    });
}

async function onDelete(effect, options, userId) {
    if (userId !== game.user.id || !engineEnabled()) return;
    const actor = effect.parent;
    if (!(actor instanceof Actor)) return;

    const id = conditionIdOf(effect.statuses, CONDITIONS_BY_ID);
    if (id && conditionMode(id) !== MODES.OFF) {
        const engine = options?.[MODULE_ID]?.[OPTION_KEYS.ENGINE];
        const reason = engine?.reason;
        const data = { actor: `<b>${esc(actorName(actor))}</b>`, condition: `<b>${esc(effect.name)}</b>`, reason: esc(reason) };
        let line;
        if (engine?.expired) line = t('chat.expired', data, '{actor} is no longer {condition} (its duration ended).');
        else if (reason) line = t('chat.endedBecause', data, '{actor} is no longer {condition} ({reason} ended).');
        else line = t('chat.ended', data, '{actor} is no longer {condition}.');
        await postLine(actor, line);
    }

    // Conditions this one brought with it lose it as a source, and end if nothing else holds them.
    await cleanupSources(actor, effect.name);
}
