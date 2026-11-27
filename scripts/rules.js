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
import { explainRules, hasRules, parseRules, resolveRules } from './logic/rules.js';
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
 * Which table entry gives an effect its default rules: the table condition its single status names, else the
 * situational entry its flag names, else (for the stance marker) the situational entry for the marker's stance.
 * @param {ActiveEffect} effect
 * @returns {{conditionId: string | null, situationalId: string | null, stanceId: string | null, entry: object | null}}
 */
function defaultsOf(effect) {
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
    return { conditionId, situationalId, stanceId, entry: entry ?? null };
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
    const { conditionId, situationalId, stanceId, entry } = defaultsOf(effect);
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

/**
 * Ids rules may name, for checking rules a person or another module writes: the table's conditions, and the
 * system's skills and attributes when its config is loaded (so a misspelt skill is caught when the rules are saved).
 */
export function authoringKnown() {
    const cosmere = globalThis.CONFIG?.COSMERE ?? {};
    const known = { conditions: KNOWN.conditions };
    if (cosmere.skills && Object.keys(cosmere.skills).length) known.skills = Object.keys(cosmere.skills);
    if (cosmere.attributes && Object.keys(cosmere.attributes).length) known.attributes = Object.keys(cosmere.attributes);
    return known;
}

/**
 * Check rules as `setRules` would, without saving them.
 * @param {unknown} rules
 * @returns {string[]} problems; empty when valid (null, "no rules of its own", is valid)
 */
export function checkRules(rules) {
    return parseRules(rules, authoringKnown()).problems;
}

/**
 * An effect's rules for authoring: what it does now, its own rules and the table's defaults, field by field.
 * @param {ActiveEffect} effect
 * @returns {{rules: object, own: object | null, stored: unknown, defaults: object, from: Record<string, string>,
 *   problems: string[], defaultsFrom: {condition: string} | {situational: string} | {stance: string} | null}}
 *   stored: the `rules` flag exactly as saved (null when unset), which may be invalid; problems: why it is ignored
 */
export function explainEffect(effect) {
    const { conditionId, situationalId, stanceId, entry } = defaultsOf(effect);
    const stored = effect?.getFlag?.(MODULE_ID, FLAGS.RULES) ?? null;
    const report = explainRules(stored, entry, KNOWN);
    const defaultsFrom = conditionId
        ? { condition: conditionId }
        : situationalId
          ? { situational: situationalId }
          : stanceId && entry
            ? { stance: stanceId }
            : null;
    return { ...report, stored, defaultsFrom };
}

/**
 * Give an effect rules of its own, or (with null) take them away so the table's defaults apply again.
 * Invalid rules are not saved; their problems are returned instead.
 * @param {ActiveEffect} effect
 * @param {unknown} rules schema 1 rules, or null
 * @returns {Promise<{ok: boolean, problems: string[], rules: object | null}>} rules: what was saved (the clean copy)
 */
export async function setOwnRules(effect, rules) {
    if (effect?.documentName !== 'ActiveEffect') throw new TypeError('setRules needs an ActiveEffect');
    const parsed = parseRules(rules, authoringKnown());
    if (!parsed.ok) return { ok: false, problems: parsed.problems, rules: null };
    // Unset first: Foundry merges an object written into a flag with the one already there, so a field the new rules
    // leave out would otherwise survive from the old ones.
    if (effect.getFlag(MODULE_ID, FLAGS.RULES) != null) {
        await effect.update({ [`flags.${MODULE_ID}.-=${FLAGS.RULES}`]: null });
    }
    if (parsed.rules) await effect.update({ [`flags.${MODULE_ID}.${FLAGS.RULES}`]: parsed.rules });
    return { ok: true, problems: [], rules: parsed.rules };
}
