/**
 * Pure helpers over the condition table. No Foundry globals.
 */
import { MECHANICS, VALUE_TYPES } from '../../data/conditions.js';
import { parseDurationSpec } from './durations.js';
import { ruleError } from './rolls.js';

/** The highest phase this release implements. */
export const RELEASE_PHASE = 3;

const KNOWN_MECHANICS = new Set(Object.values(MECHANICS));
const KNOWN_VALUE_TYPES = new Set(Object.values(VALUE_TYPES));

/**
 * Check a condition table. Returns a list of problems (empty when valid).
 * @param {object[]} table
 * @returns {string[]}
 */
export function validateTable(table) {
    const errors = [];
    const ids = new Set();

    for (const entry of table) {
        if (!entry || typeof entry.id !== 'string' || !entry.id) {
            errors.push('entry without an id');
            continue;
        }
        if (ids.has(entry.id)) errors.push(`${entry.id}: duplicate id`);
        ids.add(entry.id);

        if (typeof entry.name !== 'string' || !entry.name) errors.push(`${entry.id}: missing name`);
        if (typeof entry.summary !== 'string' || !entry.summary) errors.push(`${entry.id}: missing summary`);
        if (!Array.isArray(entry.mechanics)) errors.push(`${entry.id}: mechanics must be an array`);
        if (!Array.isArray(entry.links)) errors.push(`${entry.id}: links must be an array`);

        for (const mechanic of entry.mechanics ?? []) {
            if (!KNOWN_MECHANICS.has(mechanic)) errors.push(`${entry.id}: unknown mechanic "${mechanic}"`);
        }
        if (entry.value != null && !KNOWN_VALUE_TYPES.has(entry.value)) {
            errors.push(`${entry.id}: unknown value type "${entry.value}"`);
        }
        if ((entry.mechanics ?? []).includes(MECHANICS.ATTRIBUTE_BONUS) && entry.value !== VALUE_TYPES.ATTRIBUTE) {
            errors.push(`${entry.id}: attributeBonus needs value type "attribute"`);
        }
        if (entry.multiInstance && entry.stackable) {
            errors.push(`${entry.id}: cannot be both multiInstance and stackable`);
        }
        if (entry.links?.includes(entry.id)) errors.push(`${entry.id}: links to itself`);
        if (entry.duration != null) {
            const parsed = parseDurationSpec(entry.duration);
            if (!parsed.ok) errors.push(`${entry.id}: ${parsed.error}`);
        }
        for (const rule of entry.rolls ?? []) {
            const error = ruleError(rule);
            if (error) errors.push(`${entry.id}: roll rule: ${error}`);
            else if (rule.consume || rule.vsTarget) errors.push(`${entry.id}: consume/vsTarget are for situational effects`);
        }
    }

    for (const entry of table) {
        for (const link of entry?.links ?? []) {
            if (!ids.has(link)) errors.push(`${entry.id}: links to unknown condition "${link}"`);
        }
    }

    const cycle = findLinkCycle(table);
    if (cycle) errors.push(`link cycle: ${cycle.join(' → ')}`);

    return errors;
}

/**
 * Find a cycle in the links, if any.
 * @param {object[]} table
 * @returns {string[] | null} the ids along the cycle, first id repeated at the end
 */
export function findLinkCycle(table) {
    const byId = new Map(table.map((entry) => [entry.id, entry]));
    const state = new Map(); // id → 'visiting' | 'done'

    const visit = (id, path) => {
        if (state.get(id) === 'done') return null;
        if (state.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id];
        state.set(id, 'visiting');
        for (const link of byId.get(id)?.links ?? []) {
            const found = visit(link, [...path, id]);
            if (found) return found;
        }
        state.set(id, 'done');
        return null;
    };

    for (const entry of table) {
        const found = visit(entry.id, []);
        if (found) return found;
    }
    return null;
}

/**
 * Every condition an id brings with it, directly or through its children, in breadth-first order.
 * @param {Record<string, object>} byId
 * @param {string} id
 * @returns {string[]}
 */
export function resolveLinks(byId, id) {
    const result = [];
    const queue = [...(byId[id]?.links ?? [])];
    while (queue.length) {
        const next = queue.shift();
        if (next === id || result.includes(next)) continue;
        result.push(next);
        queue.push(...(byId[next]?.links ?? []));
    }
    return result;
}

/**
 * Whether this release (or the given phase) does anything for this entry.
 * @param {object} entry
 * @param {number} [upToPhase=1]
 */
export function isAutomated(entry, upToPhase = RELEASE_PHASE) {
    return !!entry && !entry.outOfScope && entry.phase != null && entry.phase <= upToPhase;
}

/**
 * The condition id an effect stands for, given its statuses.
 * Only effects with exactly one status that the table knows count.
 * @param {Iterable<string>} statuses
 * @param {Record<string, object>} byId
 * @returns {string | null}
 */
export function conditionIdOf(statuses, byId) {
    const list = [...(statuses ?? [])];
    if (list.length !== 1) return null;
    return byId[list[0]] ? list[0] : null;
}

/**
 * Check the situational-effects table. Returns a list of problems (empty when valid).
 * @param {object[]} table
 * @param {Set<string>} [conditionIds] ids already used by conditions (must not clash)
 */
export function validateSituational(table, conditionIds = new Set()) {
    const errors = [];
    const ids = new Set();
    const actions = new Set();
    for (const entry of table) {
        if (!entry?.id) {
            errors.push('situational entry without an id');
            continue;
        }
        if (ids.has(entry.id) || conditionIds.has(entry.id)) errors.push(`${entry.id}: duplicate id`);
        ids.add(entry.id);
        if (!entry.name || !entry.summary) errors.push(`${entry.id}: missing name or summary`);
        if (!!entry.action === !!entry.stance) errors.push(`${entry.id}: needs exactly one of action or stance`);
        if (entry.action) {
            if (actions.has(entry.action)) errors.push(`${entry.id}: action "${entry.action}" used twice`);
            actions.add(entry.action);
        }
        if (!Array.isArray(entry.rolls) || !entry.rolls.length) errors.push(`${entry.id}: no roll rules`);
        for (const rule of entry.rolls ?? []) {
            const error = ruleError(rule);
            if (error) errors.push(`${entry.id}: roll rule: ${error}`);
            if (rule.vsTarget && !entry.needsTarget) errors.push(`${entry.id}: vsTarget needs needsTarget`);
        }
        if (entry.duration != null) {
            const parsed = parseDurationSpec(entry.duration);
            if (!parsed.ok) errors.push(`${entry.id}: ${parsed.error}`);
        }
        for (const end of entry.endsWhen ?? []) {
            if (!['attack', 'move'].includes(end)) errors.push(`${entry.id}: unknown endsWhen "${end}"`);
        }
        if (entry.stance && (entry.duration || entry.endsWhen)) errors.push(`${entry.id}: a stance rule has no duration`);
    }
    return errors;
}
