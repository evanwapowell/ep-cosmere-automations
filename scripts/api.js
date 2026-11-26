/**
 * Public API: game.modules.get('ep-cosmere-automations').api
 * Everything goes through the same path as the token HUD, so nothing is applied twice.
 */
import { CONDITIONS, CONDITIONS_BY_ID } from '../data/conditions.js';
import { cleanupSources, conditionEffects, createCondition } from './conditions.js';
import { FLAGS, MODULE_ID } from './constants.js';
import { advanceDays, buildDuration, durationText, endScene, setDuration, useUp } from './durations.js';
import { activeConditions } from './mechanics.js';
import { addSource, describeSources, effectKey, itemKey, MANUAL, readSources } from './logic/sources.js';
import { normalizeValue } from './logic/values.js';
import { conditionMode } from './settings.js';
import { endStance, syncStanceMarker } from './stances.js';
import { createSituational, situationalEffects } from './situational.js';
import { sideOf } from './rolls.js';
import { collectModifiers, netMode } from './logic/rolls.js';
import { SITUATIONAL, SITUATIONAL_BY_ID } from '../data/situational.js';
import { SETTINGS, featureMode, weakerMode } from './settings.js';
import { systemChoices } from './util.js';

/**
 * Turn the API's `source` option into a stored source.
 * @param {Actor} actor
 * @param {undefined | string | {key: string, label: string} | Item | ActiveEffect} source
 */
function toSource(actor, source) {
    if (!source) return { ...MANUAL };
    if (typeof source === 'string') return { key: source, label: source };
    if (source.documentName === 'Item' && source.parent === actor) return { key: itemKey(source.id), label: source.name };
    if (source.documentName === 'ActiveEffect' && source.parent === actor) {
        return { key: effectKey(source.id), label: source.name };
    }
    if (typeof source.key === 'string') return { key: source.key, label: source.label ?? source.key };
    throw new Error('source must be an item or effect on the same actor, a string, or {key, label}');
}

/**
 * Apply a condition.
 * @param {Actor} actor
 * @param {string} id condition id ('prone', 'afflicted', …)
 * @param {object} [options]
 * @param {object} [options.value]  Afflicted: {type, amount}; Enhanced: {attribute, amount}
 * @param {number} [options.stacks] Exhausted: stacks to add (default 1)
 * @param {Item | ActiveEffect | string | {key, label}} [options.source] why; it ends when an item or effect source is deleted
 * @param {string | string[] | {kinds, days, turnOf}} [options.duration] how long it lasts ('endOfNextTurn',
 *   ['untilUsed', 'endOfNextTurn'], {kinds: 'days', days: 3}, 'none'); default: the table's default, else until removed.
 *   On a condition already present, a given duration replaces the old one.
 * @returns {Promise<ActiveEffect | null>}
 */
async function apply(actor, id, { value, stacks, source, duration } = {}) {
    const entry = CONDITIONS_BY_ID[id];
    if (!entry) throw new Error(`Unknown condition "${id}"`);
    if (!actor) throw new Error('No actor');

    let checkedValue = null;
    if (entry.value && value) {
        const choices = systemChoices();
        const checked = normalizeValue(entry, value, {
            damageTypes: Object.keys(choices.damageTypes),
            attributes: Object.keys(choices.attributes),
        });
        if (!checked.ok) throw new Error(checked.error);
        checkedValue = checked.value;
    }
    const src = toSource(actor, source);
    const existing = conditionEffects(actor, id);
    const durationState = buildDuration(actor, duration !== undefined ? duration : entry.duration);

    if (existing.length && entry.multiInstance) {
        return createCondition(actor, id, {
            value: checkedValue,
            sources: [src],
            extraInstance: true,
            duration: durationState,
        });
    }
    if (existing.length) {
        const effect = existing[0];
        const update = {};
        const stored = effect.getFlag(MODULE_ID, FLAGS.SOURCES);
        const sources = addSource(readSources(stored), src);
        if (!Array.isArray(stored) || sources.length !== readSources(stored).length) {
            update[`flags.${MODULE_ID}.${FLAGS.SOURCES}`] = sources;
        }
        if (entry.stackable) update['system.stacks'] = (effect.system?.stacks ?? 1) + Math.max(1, stacks ?? 1);
        if (Object.keys(update).length) await effect.update(update);
        if (duration !== undefined) await setDuration(effect, duration);
        return effect;
    }
    return createCondition(actor, id, {
        value: checkedValue,
        sources: [src],
        stacks: entry.stackable ? Math.max(1, stacks ?? 1) : undefined,
        duration: durationState,
    });
}

/**
 * Remove a condition (every instance of it), or one source of it when `source` is given.
 * @param {Actor} actor
 * @param {string} id
 * @param {{source?: Item | ActiveEffect | string | {key, label}}} [options]
 */
async function remove(actor, id, { source } = {}) {
    const effects = conditionEffects(actor, id);
    if (!effects.length) return [];
    if (source) {
        const key = toSource(actor, source).key;
        const orphans = [];
        for (const effect of effects) {
            const current = readSources(effect.getFlag(MODULE_ID, FLAGS.SOURCES));
            const next = current.filter((s) => s.key !== key);
            if (next.length === current.length) continue;
            if (next.length) await effect.setFlag(MODULE_ID, FLAGS.SOURCES, next);
            else orphans.push(effect.id); // nothing holds it any more
        }
        if (orphans.length) await actor.deleteEmbeddedDocuments('ActiveEffect', orphans);
        return orphans;
    }
    const ids = effects.map((e) => e.id);
    await actor.deleteEmbeddedDocuments('ActiveEffect', ids);
    return ids;
}

/**
 * The actor's conditions with values, stacks and sources.
 * @param {Actor} actor
 */
function list(actor) {
    const active = new Set(activeConditions(actor).map((c) => c.effect.id));
    return conditionEffects(actor).map((effect) => {
        const id = [...effect.statuses][0];
        const sources = readSources(effect.getFlag(MODULE_ID, FLAGS.SOURCES));
        return {
            id,
            effectId: effect.id,
            name: effect.name,
            active: active.has(effect.id),
            mode: conditionMode(id),
            value: effect.getFlag(MODULE_ID, FLAGS.VALUE) ?? null,
            stacks: CONDITIONS_BY_ID[id]?.stackable ? (effect.system?.stacks ?? 1) : null,
            sources,
            from: describeSources(sources),
            duration: effect.getFlag(MODULE_ID, FLAGS.DURATION) ?? null,
            lasts: durationText(effect),
        };
    });
}

/**
 * Put a situational effect on an actor: 'dodging', 'bracing', or 'advantage' (needs `target`).
 * @param {Actor} actor
 * @param {string} id
 * @param {{target?: Actor, duration?: unknown}} [options]
 */
function mark(actor, id, { target, duration } = {}) {
    return createSituational(actor, id, { target, duration });
}

/** The actor's situational effects: [{id, name, value, lasts}]. */
function marks(actor) {
    return situationalEffects(actor).map(({ id, value, effect }) => ({
        id,
        effectId: effect.id,
        name: effect.name,
        value,
        lasts: durationText(effect),
    }));
}

/**
 * Preview the advantages and disadvantages a test would get, without rolling.
 * @param {Actor} actor the roller
 * @param {{target?: Actor, context?: 'Skill' | 'Item' | 'Attack', skill?: string, attackType?: 'melee' | 'ranged', base?: string}} [test]
 */
function modifiers(actor, { target = null, context = 'Skill', skill = null, attackType = null, base = 'none' } = {}) {
    const rolls = featureMode(SETTINGS.ROLLS);
    const modeOf = (key) => (key.startsWith('situational:') ? rolls : weakerMode(rolls, conditionMode(key)));
    const mods = collectModifiers(
        { roller: sideOf(actor), target: sideOf(target), test: { context, skill, attackType } },
        { conditions: CONDITIONS_BY_ID, situational: SITUATIONAL_BY_ID, modeOf },
    );
    return { modifiers: mods, mode: netMode(base, mods) };
}

export function buildApi() {
    return Object.freeze({
        apply,
        remove,
        list,
        endStance,
        syncStanceMarker,
        cleanupSources,
        endScene,
        advanceDays,
        setDuration,
        use: useUp,
        mark,
        marks,
        modifiers,
        conditions: CONDITIONS,
        situational: SITUATIONAL,
    });
}
