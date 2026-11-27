/**
 * Where an effect's rules come from: the one place that reads the rules tables.
 *
 * The effect's own rules (`flags[MODULE_ID].rules`) win per field; a field it doesn't set takes the default of the
 * table entry for the effect's single status (data/conditions.js) or its `situational` flag (data/situational.js).
 * See "Defaults and overrides" in DESIGN.md. Identity (names, summaries, value type, `stackable`, `phase`) is not
 * rules and stays on the tables.
 */
import { CONDITIONS_BY_ID } from '../data/conditions.js';
import { SITUATIONAL_BY_ID } from '../data/situational.js';
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
 *   stacks: number | undefined, value: object | null}}
 *   rules: normalized (see scripts/logic/rules.js), read-only; `{schema: 1}` when it has none;
 *   conditionId: the table condition its single status names; situationalId: the table entry its flag names;
 *   stacks: `system.stacks`; value: its `value` flag
 */
export function describeEffect(effect) {
    const conditionId = conditionIdOf(effect?.statuses, CONDITIONS_BY_ID);
    const flagged = effect?.getFlag?.(MODULE_ID, FLAGS.SITUATIONAL);
    const situationalId = flagged && SITUATIONAL_BY_ID[flagged] ? flagged : null;
    const entry = conditionId ? CONDITIONS_BY_ID[conditionId] : situationalId ? SITUATIONAL_BY_ID[situationalId] : null;
    const own = effect?.getFlag?.(MODULE_ID, FLAGS.RULES);
    const { rules, problems } = resolveRules(own, entry, KNOWN);
    if (effect) warnOnce(effect, own, problems);
    return {
        effect,
        rules,
        conditionId,
        situationalId,
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
 * The effects that apply to an actor: its own, and with `transferred` also those its items transfer to it (a
 * talent's or a stance's effect). Foundry v13's `allApplicableEffects()` gives both; cosmere-rpg 3.1.x overrides it
 * to add the effects of nested items. Disabled and suppressed effects are left out here, so a stance the actor is
 * not in (the system disables its effects) never counts.
 * @param {Actor} actor
 * @param {boolean} transferred
 * @returns {Iterable<ActiveEffect>}
 */
function applyingEffects(actor, transferred) {
    if (transferred && typeof actor?.allApplicableEffects === 'function') return actor.allApplicableEffects();
    return actor?.effects ?? [];
}

/**
 * An actor's enabled, unsuppressed effects that resolve to any rules.
 * @param {Actor} actor
 * @param {{includeEmpty?: boolean, transferred?: boolean}} [options] includeEmpty: also the effects with no rules
 *   at all (a condition that is only a marker, like Surprised), for callers that need to know the condition is
 *   there; transferred: also the effects the actor's items transfer to it (the mechanics layer reads these; the
 *   other layers, which may delete or update what they find, read only the actor's own effects for now)
 * @returns {ReturnType<typeof describeEffect>[]}
 */
export function ruleEffects(actor, { includeEmpty = false, transferred = false } = {}) {
    const list = [];
    for (const effect of applyingEffects(actor, transferred)) {
        if (!effect || effect.disabled || effect.isSuppressed) continue;
        const row = describeEffect(effect);
        if (includeEmpty || hasRules(row.rules)) list.push(row);
    }
    return list;
}
