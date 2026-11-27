/**
 * Where an effect's rules come from: the one place that reads the rules tables.
 *
 * The effect's own rules (`flags[MODULE_ID].rules`) win per field; a field it doesn't set takes the default of the
 * table entry for the effect's single status (data/conditions.js), its `situational` flag (data/situational.js),
 * or, for the stance marker (scripts/stances.js), the situational entry for the marker's stance.
 * See "Defaults and overrides" in DESIGN.md. Identity (names, summaries, value type, `stackable`, `phase`) is not
 * rules and stays on the tables.
 */
import { CONDITIONS_BY_ID } from '../data/conditions.js';
import { SITUATIONAL_BY_ID } from '../data/situational.js';
import { stanceEntry } from './logic/rolls.js';
import { FLAGS, MODULE_ID } from './constants.js';
import { hasRules, resolveRules } from './logic/rules.js';
import { conditionIdOf } from './logic/table.js';
import { warn } from './util.js';

/** Ids rules may name, for the checks that don't need the system's config. */
const KNOWN = Object.freeze({ conditions: Object.keys(CONDITIONS_BY_ID) });

/** The own rules each effect was last warned about, so a problem is reported once, not on every roll. */
const warned = new WeakMap();

function warnOnce(effect, own, problems) {
    if (!problems.length) {
        warned.delete(effect);
        return;
    }
    let key;
    try {
        key = JSON.stringify(own);
    } catch {
        key = String(own);
    }
    if (warned.get(effect) === key) return;
    warned.set(effect, key);
    warn(`Ignoring the rules on "${effect.name ?? effect.id}" (the table's defaults apply instead):`, problems.join('; '));
}

/**
 * An effect with its resolved rules.
 * @param {ActiveEffect} effect
 * @returns {{effect: ActiveEffect, rules: object, conditionId: string | null, situationalId: string | null,
 *   stanceId: string | null, stacks: number | undefined, value: object | null}}
 *   rules: normalized (see scripts/logic/rules.js), read-only; `{schema: 1}` when it has none;
 *   conditionId: the table condition its single status names; situationalId: the table entry its flag names;
 *   stanceId: for the stance marker, the stance talent's system id (its defaults: the situational entry with that
 *   `stance`, if any); stacks: `system.stacks`; value: its `value` flag
 */
export function describeEffect(effect) {
    const conditionId = conditionIdOf(effect?.statuses, CONDITIONS_BY_ID);
    const flagged = effect?.getFlag?.(MODULE_ID, FLAGS.SITUATIONAL);
    const situationalId = flagged && SITUATIONAL_BY_ID[flagged] ? flagged : null;
    const marker = conditionId || situationalId ? null : effect?.getFlag?.(MODULE_ID, FLAGS.STANCE_MARKER);
    const stanceId = typeof marker === 'string' && marker ? marker : null;
    const entry = conditionId
        ? CONDITIONS_BY_ID[conditionId]
        : situationalId
          ? SITUATIONAL_BY_ID[situationalId]
          : stanceEntry(stanceId, SITUATIONAL_BY_ID);
    const own = effect?.getFlag?.(MODULE_ID, FLAGS.RULES);
    const { rules, problems } = resolveRules(own, entry, KNOWN);
    if (effect) warnOnce(effect, own, problems);
    return {
        effect,
        rules,
        conditionId,
        situationalId,
        stanceId,
        stacks: effect?.system?.stacks,
        value: effect?.getFlag?.(MODULE_ID, FLAGS.VALUE) ?? null,
    };
}

/**
 * What rules an effect has: its own, field by field, over the table's defaults. Invalid own rules are ignored with
 * one console warning per effect; this never throws.
 * @param {ActiveEffect} effect
 * @returns {object} normalized rules; `{schema: 1}` when there are none
 */
export function rulesOf(effect) {
    return describeEffect(effect).rules;
}

/**
 * An actor's enabled, unsuppressed effects that resolve to any rules.
 * @param {Actor} actor
 * @param {{includeEmpty?: boolean}} [options] includeEmpty: also the effects with no rules at all (a condition
 *   that is only a marker, like Surprised), for callers that need to know the condition is there
 * @returns {ReturnType<typeof describeEffect>[]}
 */
export function ruleEffects(actor, { includeEmpty = false } = {}) {
    const list = [];
    for (const effect of actor?.effects ?? []) {
        if (effect.disabled || effect.isSuppressed) continue;
        const row = describeEffect(effect);
        if (includeEmpty || hasRules(row.rules)) list.push(row);
    }
    return list;
}
