/**
 * Condition values (Afflicted [3 keen], Enhanced [Strength +1]) and the effect data they imply.
 * Pure functions, no Foundry globals.
 */
import { MECHANICS, VALUE_TYPES } from '../../data/conditions.js';

/** Foundry's CONST.ACTIVE_EFFECT_MODES (stable since v10). */
export const EFFECT_MODES = Object.freeze({ CUSTOM: 0, MULTIPLY: 1, ADD: 2, DOWNGRADE: 3, UPGRADE: 4, OVERRIDE: 5 });

/**
 * Check and normalize a raw value (from a dialog or the API) for a condition entry.
 * @param {object} entry condition table entry
 * @param {object} raw
 * @param {{damageTypes?: string[], attributes?: string[]}} [choices] valid ids, when known
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function normalizeValue(entry, raw, choices = {}) {
    if (!entry?.value) return { ok: true, value: null };
    if (!raw || typeof raw !== 'object') return { ok: false, error: `${entry.id} needs a value` };

    const amount = Number(raw.amount);
    if (!Number.isInteger(amount)) return { ok: false, error: `${entry.id}: amount must be a whole number` };

    if (entry.value === VALUE_TYPES.DAMAGE) {
        if (amount < 1) return { ok: false, error: `${entry.id}: damage must be at least 1` };
        const type = typeof raw.type === 'string' ? raw.type : '';
        if (!type) return { ok: false, error: `${entry.id}: damage type missing` };
        if (choices.damageTypes && !choices.damageTypes.includes(type)) {
            return { ok: false, error: `${entry.id}: unknown damage type "${type}"` };
        }
        return { ok: true, value: { type, amount } };
    }

    if (entry.value === VALUE_TYPES.ATTRIBUTE) {
        if (amount === 0) return { ok: false, error: `${entry.id}: amount cannot be 0` };
        const attribute = typeof raw.attribute === 'string' ? raw.attribute : '';
        if (!attribute) return { ok: false, error: `${entry.id}: attribute missing` };
        if (choices.attributes && !choices.attributes.includes(attribute)) {
            return { ok: false, error: `${entry.id}: unknown attribute "${attribute}"` };
        }
        return { ok: true, value: { attribute, amount } };
    }

    return { ok: false, error: `${entry.id}: unknown value type "${entry.value}"` };
}

/**
 * Short value text for the effect's name: "3 Keen", "Strength +1".
 * @param {object} entry
 * @param {object | null} value
 * @param {{damageTypes?: Record<string, string>, attributes?: Record<string, string>}} [labels]
 */
export function formatValue(entry, value, labels = {}) {
    if (!entry?.value || !value) return '';
    if (entry.value === VALUE_TYPES.DAMAGE) {
        return `${value.amount} ${labels.damageTypes?.[value.type] ?? value.type}`;
    }
    if (entry.value === VALUE_TYPES.ATTRIBUTE) {
        const sign = value.amount > 0 ? '+' : '−';
        return `${labels.attributes?.[value.attribute] ?? value.attribute} ${sign}${Math.abs(value.amount)}`;
    }
    return '';
}

/**
 * Name, changes and flags an effect gets for a value.
 * @param {object} entry
 * @param {object | null} value
 * @param {{baseName: string, full: boolean, labels?: object, flagScope: string}} options
 *   full: the condition is in "full" mode, so mechanics are written as effect changes
 * @returns {{name: string, changes?: object[], flags: object}}
 */
export function valueEffectData(entry, value, { baseName, full, labels, flagScope }) {
    const text = formatValue(entry, value, labels);
    const data = {
        name: text ? `${baseName} [${text}]` : baseName,
        flags: { [flagScope]: { value } },
    };
    if (full && entry.mechanics?.includes(MECHANICS.ATTRIBUTE_BONUS) && value?.attribute) {
        data.changes = [
            { key: `system.attributes.${value.attribute}.bonus`, mode: EFFECT_MODES.ADD, value: String(value.amount) },
        ];
    }
    return data;
}

/**
 * A 16-character effect id for an extra instance of a condition.
 * Starts with `cond<status>` so the system still lists it among the actor's conditions,
 * and differs from the system's own id (`cond<status>` padded with zeros).
 * @param {string} status
 * @param {() => string} randomId returns at least 16 random alphanumeric characters
 */
export function instanceId(status, randomId) {
    const prefix = `cond${status}`.slice(0, 15);
    const base = `cond${status}`.padEnd(16, '0').slice(0, 16);
    for (let attempt = 0; attempt < 10; attempt++) {
        const id = (prefix + randomId()).slice(0, 16);
        if (id !== base && /^[a-zA-Z0-9]{16}$/.test(id)) return id;
    }
    return randomId().slice(0, 16);
}
