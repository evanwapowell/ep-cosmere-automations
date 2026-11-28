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
    heldStacks,
    holders,
    isSourceGone,
    MANUAL,
    planLinks,
    planSourceRemoval,
    readSources,
} from './logic/sources.js';
import { conditionIdOf } from './logic/table.js';
import { instanceId } from './logic/values.js';
import { defaultDuration } from './logic/rules.js';
import { rulesOf } from './rules.js';
import { buildDuration, durationText, shouldAskDuration } from './durations.js';
import { conditionMode, effectRulesMode, engineEnabled, featureMode, SETTINGS } from './settings.js';
import { actorName, esc, safe, serial, statusLabel, t, warn } from './util.js';
import { askDetails } from './values.js';

export function registerConditionHooks() {
    Hooks.on('createActiveEffect', safe('createActiveEffect', onCreate));
    Hooks.on('deleteActiveEffect', safe('deleteActiveEffect', onDelete));
    // A condition another source holds can't be removed (or its held stacks taken) by hand (as in PF2e).
    Hooks.on('preDeleteActiveEffect', safe('preDeleteActiveEffect', onPreDelete));
    Hooks.on('preUpdateActiveEffect', safe('preUpdateActiveEffect', onPreUpdate));
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

/** Options marking a change as the engine's own. `chain`: the links being followed (see `planLinks`). */
function engineOptions(reason, chain) {
    const engine = { reason: reason ?? '' };
    if (chain?.length) engine.chain = chain;
    return { [MODULE_ID]: { [OPTION_KEYS.ENGINE]: engine } };
}

/**
 * Create a condition effect on an actor through the system's own status data.
 * @param {Actor} actor
 * @param {string} id
 * @param {{value?: object, sources?: {key: string, label: string}[], stacks?: number, extraInstance?: boolean,
 *   duration?: object | null, reason?: string, chain?: string[]}} [options] duration: a stored duration state
 *   (null: none); chain: the links being followed, so a loop through effects' own rules stops
 * @returns {Promise<ActiveEffect | null>}
 */
export async function createCondition(actor, id, { value, sources, stacks, extraInstance, duration, reason, chain } = {}) {
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
    return cls.create(data, { parent: actor, keepId: true, ...engineOptions(reason, chain) });
}

/**
 * Make sure a linked condition is on the actor, with `source` among its sources.
 * A condition already there without our flags was applied by hand: it keeps a manual source.
 */
async function ensureLinked(actor, id, source, chain) {
    const existing = conditionEffects(actor, id)[0];
    if (!existing) return createCondition(actor, id, { sources: [source], reason: source.label, chain });
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
    if (!id) return linkOther(effect, actor, options);
    const mode = conditionMode(id);
    if (mode === MODES.OFF) return;
    const entry = CONDITIONS_BY_ID[id];
    const rules = rulesOf(effect);
    const defaultSpec = defaultDuration(rules);

    // Value and duration first, so the chat line can show them. The engine and the API set their own.
    const byEngine = !!options?.[MODULE_ID]?.[OPTION_KEYS.ENGINE];
    const askValue = !!entry.value && !effect.getFlag(MODULE_ID, FLAGS.VALUE);
    const hasDuration = effect.getFlag(MODULE_ID, FLAGS.DURATION) != null;
    const askDuration = !byEngine && !hasDuration && shouldAskDuration();
    if (askValue || askDuration) {
        await askDetails(effect, id, actorName(actor), { askValue, askDuration });
    } else if (!byEngine && !hasDuration && defaultSpec && featureMode(SETTINGS.DURATIONS) !== MODES.OFF) {
        const duration = buildDuration(actor, defaultSpec);
        if (duration) await effect.setFlag(MODULE_ID, FLAGS.DURATION, duration);
    }
    if (!actor.effects.has(effect.id)) return; // removed while the dialog was open

    const from = describeSources(readSources(storedSources(effect)));
    const links = (rules.links ?? []).map((link) => statusLabel(link, CONDITIONS_BY_ID[link]?.name));
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

    if (mode === MODES.FULL) await applyLinks(effect, actor, options, rules.links, { chainKey: id, label: plainName(id) });
}

/**
 * An effect that isn't a table condition (a talent's, an item's, a homebrew "Pinned") can bring conditions with it
 * too, when its resolved rules have `links`. It follows "Rules on other effects", like its other rules: full brings
 * the linked conditions (they end with it like a table condition's do), remind only posts a reminder naming them,
 * off does nothing. A disabled effect brings nothing.
 */
async function linkOther(effect, actor, options) {
    if (effect.disabled) return;
    const links = rulesOf(effect).links;
    if (!links?.length) return;
    const mode = effectRulesMode(null);
    if (mode === MODES.OFF) return;
    const label = effect.name || effect.id;
    if (mode === MODES.REMIND) {
        const list = links.map((link) => statusLabel(link, CONDITIONS_BY_ID[link]?.name)).join(', ');
        await postLine(
            actor,
            t('chat.linkReminder', { effect: `<b>${esc(label)}</b>`, actor: `<b>${esc(actorName(actor))}</b>` }, '{actor} has {effect}.'),
            { reminder: t('chat.alsoApply', { list }, 'Also apply: {list}.') },
        );
        return;
    }
    await applyLinks(effect, actor, options, links, { chainKey: effectKey(effect.id), label });
}

/**
 * Put an effect's linked conditions on the actor, each with the effect as a source.
 * `chainKey` names the effect in the chain of links being followed: a created link carries the chain in the options
 * of its own creation, so a condition already being applied higher up is not linked again, and a chain has a depth
 * limit (`planLinks`). Either way the engine stops with a warning.
 */
async function applyLinks(effect, actor, options, links, { chainKey, label }) {
    if (!links?.length) return;
    const chain = [...(options?.[MODULE_ID]?.[OPTION_KEYS.ENGINE]?.chain ?? []), chainKey];
    const { apply, skipped } = planLinks(chain, links);
    for (const { id, reason } of skipped) warnLinkStopped(actor, label, id, reason);
    if (!apply.length) return;
    await serial(actor.uuid, async () => {
        for (const link of apply) {
            if (!actor.effects.has(effect.id)) break; // removed meanwhile
            await ensureLinked(actor, link, { key: effectKey(effect.id), label }, chain);
        }
    });
}

function warnLinkStopped(actor, parent, id, reason) {
    const data = { actor: actorName(actor), parent, condition: statusLabel(id, CONDITIONS_BY_ID[id]?.name) };
    const message =
        reason === 'loop'
            ? t('notify.linkLoop', data, '{actor}: {parent} would bring {condition}, which is already being applied here. Not linked again; check the rules of these effects for a loop.')
            : t('notify.linkDepth', data, '{actor}: the links from {parent} to {condition} go too deep. Stopped; check the rules of these effects for a loop.');
    warn(message);
    ui.notifications?.warn(message);
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
            effects.map((e) => ({ id: e.id, sources: storedSources(e), stacks: isStackable(e) ? (e.system?.stacks ?? 1) : undefined })),
            (key) => isSourceGone(key, present),
        );
        const deletes = plan.filter((p) => p.action === 'delete' && actor.effects.has(p.id)).map((p) => p.id);
        const updates = plan
            .filter((p) => p.action === 'update' && actor.effects.has(p.id))
            .map((p) => {
                const update = { _id: p.id, [`flags.${MODULE_ID}.${FLAGS.SOURCES}`]: p.sources };
                if (p.stacks != null) update['system.stacks'] = p.stacks;
                return update;
            });
        if (updates.length) await actor.updateEmbeddedDocuments('ActiveEffect', updates, engineOptions(reason));
        if (deletes.length) await actor.deleteEmbeddedDocuments('ActiveEffect', deletes, engineOptions(reason));
    });
}

function isStackable(effect) {
    return !!CONDITIONS_BY_ID[conditionIdOf(effect.statuses, CONDITIONS_BY_ID)]?.stackable;
}

/** Whether a source on this effect's actor no longer exists. */
function goneOn(actor) {
    const present = {
        effectIds: new Set((actor.effects?.contents ?? []).map((e) => e.id)),
        itemIds: new Set((actor.items?.contents ?? []).map((i) => i.id)),
    };
    return (key) => isSourceGone(key, present);
}

/**
 * The sources still holding a condition the engine tracks, or null when it is free to change by hand.
 * The engine's own changes (links ending, durations, long rest), the API's `force` and conditions in off mode pass.
 */
function heldBy(effect, options) {
    if (!engineEnabled() || options?.[MODULE_ID]?.[OPTION_KEYS.ENGINE]) return null;
    const actor = effect.parent;
    if (!(actor instanceof Actor)) return null;
    const id = conditionIdOf(effect.statuses, CONDITIONS_BY_ID);
    if (!id || conditionMode(id) === MODES.OFF) return null;
    const stored = storedSources(effect);
    if (!Array.isArray(stored)) return null; // never touched by the engine
    const sources = readSources(stored);
    const isGone = goneOn(actor);
    const { held, manual } = holders(sources, isGone);
    return held.length ? { id, actor, sources, held, manual, isGone } : null;
}

/** A condition's plain name: the effect's own name carries the stack count or value ("Exhausted [-2]"), which a
 * message about holding or a stored source label shouldn't repeat (it may be about to change). */
const plainName = (id) => statusLabel(id, CONDITIONS_BY_ID[id]?.name);

function warnHeld(hold) {
    ui.notifications?.warn(
        t(
            'notify.held',
            { actor: actorName(hold.actor), condition: plainName(hold.id), source: hold.held.join(', ') },
            '{actor}: {condition} comes from {source}. Remove that first.',
        ),
    );
}

/** Removing a held condition by hand: refused; a hand-applied source it also had goes (with its free stacks). */
function onPreDelete(effect, options) {
    const hold = heldBy(effect, options);
    if (!hold) return;
    if (hold.manual) {
        const update = { [`flags.${MODULE_ID}.${FLAGS.SOURCES}`]: hold.sources.filter((s) => s.key !== MANUAL.key) };
        if (isStackable(effect)) update['system.stacks'] = Math.max(1, heldStacks(hold.sources, hold.isGone));
        effect.update(update, engineOptions());
    }
    warnHeld(hold);
    return false;
}

/** Taking a stackable condition below the stacks its sources hold, by hand: refused. */
function onPreUpdate(effect, changes, options) {
    const next = changes?.['system.stacks'] ?? foundry.utils.getProperty(changes ?? {}, 'system.stacks');
    if (typeof next !== 'number' || !isStackable(effect) || next >= (effect.system?.stacks ?? 1)) return;
    const hold = heldBy(effect, options);
    if (!hold || next >= heldStacks(hold.sources, hold.isGone)) return;
    warnHeld(hold);
    return false;
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
