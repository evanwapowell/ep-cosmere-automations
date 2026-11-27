/**
 * The roll layer's logic: which advantages and disadvantages apply to a test, and the mode they net to.
 * Pure functions, no Foundry globals.
 *
 * Advantages and disadvantages cancel one for one (handbook ch. 9); the system models one advantage mode on the
 * d20, so whatever is left over decides the mode.
 */
import { ROLL_MODES, ROLL_TESTS, ROLL_WHO } from '../../data/conditions.js';
import { FACT, factsIn, holds, rollFacts, rulePredicate, validatePredicate } from './predicates.js';
// rules.js imports ruleProblems from here; both only use the other's exports inside functions, so the cycle is safe.
import { defaultRules } from './rules.js';

export const ADV = 'advantage';
export const DIS = 'disadvantage';
export const NONE = 'none';

/** The first problem with a roll rule's fixed fields (`who`, `mode`, `tests` and the flags), or null. */
function shapeError(rule) {
    if (!rule || typeof rule !== 'object') return 'rule must be an object';
    if (!ROLL_WHO.includes(rule.who)) return `unknown "who" ${JSON.stringify(rule.who)}`;
    if (!ROLL_MODES.includes(rule.mode)) return `unknown mode ${JSON.stringify(rule.mode)}`;
    const tests = rule.tests;
    const okTests =
        (tests == null && rule.when != null) || // a rule with a `when` may leave `tests` out: every test
        ROLL_TESTS.includes(tests) ||
        (tests && typeof tests === 'object' && Array.isArray(tests.skills) && tests.skills.length > 0);
    if (!okTests) return `unknown tests ${JSON.stringify(tests)}`;
    if (rule.vsTarget && rule.who !== 'self') return 'vsTarget only makes sense for who: self';
    if (rule.beyondSenses && rule.who !== 'self') return 'beyondSenses only makes sense for who: self';
    return null;
}

/**
 * Check one roll rule: its fixed fields, then its `when` (scripts/logic/predicates.js).
 * @param {object} rule
 * @param {{conditions?: Iterable<string> | null, skills?: Iterable<string> | null}} [known] valid ids, when known
 *   (the facts of a `when` are then checked against them)
 * @returns {string[]} the problems, empty when valid; a problem with the fixed fields is reported alone
 */
export function ruleProblems(rule, known) {
    const error = shapeError(rule);
    if (error) return [error];
    return rule.when == null ? [] : validatePredicate(rule.when, known);
}

/**
 * Check one roll rule. Returns an error string (the first problem) or null.
 * @param {object} rule
 * @param {object} [known] as for `ruleProblems`
 */
export function ruleError(rule, known) {
    return ruleProblems(rule, known)[0] ?? null;
}

/**
 * Whether a target is beyond a roller's senses range (for Senseblind).
 * @param {{distance: number | null, sensesRange: number | null, obscuredAffected?: boolean}} input
 *   distance: between the two tokens, in the scene's units (feet); sensesRange: the roller's, same units;
 *   obscuredAffected: false for a character whose senses aren't affected by obscurement
 * @returns {boolean | null} null when it can't be told
 */
export function beyondSenses({ distance, sensesRange, obscuredAffected = true }) {
    if (obscuredAffected === false) return false;
    if (!Number.isFinite(distance) || !Number.isFinite(sensesRange)) return null;
    return distance > sensesRange;
}

/**
 * Melee or ranged, for an attack rolled from an item. In cosmere-rpg 3.1.2 (seen live 2026-11-25) the item the
 * attack hooks get is often not the weapon:
 * - a character's attack is the weapon's "Strike: X" action, an item embedded in the weapon; the type is on the
 *   parent weapon (`system.attack.type`);
 * - an adversary's "Strike: X" is a plain action with no attack data; its description says "Reach 5 ft." (melee)
 *   or "Range 80/120 ft." (ranged).
 * Unknown (or both words) → null, and melee/ranged rules don't apply.
 * @param {{system?: {attack?: {type?: string}, description?: {value?: string}}, parent?: unknown}} item
 * @returns {'melee' | 'ranged' | null}
 */
export function attackTypeOf(item) {
    const own = item?.system?.attack?.type ?? item?.parent?.system?.attack?.type;
    if (own === 'melee' || own === 'ranged') return own;
    const text = String(item?.system?.description?.value ?? '').replace(/<[^>]*>/g, ' ');
    const reach = /\breach\b/i.test(text);
    const range = /\brange\b/i.test(text);
    if (reach === range) return null;
    return reach ? 'melee' : 'ranged';
}

/**
 * Whether a rule applies, given the facts of a test: its shorthand fields (`tests`, `beyondSenses`, `vsTarget`)
 * and its `when` are one predicate (`rulePredicate`).
 * @param {object} rule
 * @param {Set<string>} facts the test's facts (`rollFacts`)
 * @param {object | null} [value] the value of the effect that carries the rule (for `vsTarget`)
 */
export function ruleApplies(rule, facts, value) {
    return holds(rulePredicate(rule, value), facts);
}

/**
 * Whether a rule covers a test, going by the test alone: neither side is known here, so facts about the roller
 * or the target are false, and `vsTarget` is left to the caller. `collectModifiers` decides with both sides.
 * @param {object} rule
 * @param {{context: string, skill?: string | null, attackType?: string | null, beyondSenses?: boolean | null}} test
 *   context: the system's roll context ('Skill', 'Item', 'Attack');
 *   beyondSenses: the target is farther than the roller's senses range (null: not measured)
 */
export function ruleMatchesTest(rule, test) {
    return ruleApplies({ ...rule, vsTarget: false }, rollFacts({ test }));
}

/** The modifier key (and mode key) of a source that is not one of the tables' entries: see `rollSources`. */
export const effectKey = (effectId) => `effect:${effectId}`;

/** The mode key of a situational or stance entry of data/situational.js. */
export const situationalKey = (id) => `situational:${id}`;

/** The table entry whose rules a stance gives (data/situational.js `stance`), or null. */
export function stanceEntry(stanceId, situational) {
    if (!stanceId) return null;
    return Object.values(situational ?? {}).find((entry) => entry.stance === stanceId) ?? null;
}

/**
 * Where a test's modifiers can come from: one source per effect that has roll rules.
 *
 * @param {Row[]} rows an actor's effects with their resolved rules (`ruleEffects` in scripts/rules.js)
 * @param {{conditions: Record<string, object>, situational: Record<string, object>}} tables
 *   the condition and situational tables by id, for the labels and keys of the effects they describe
 * @returns {Source[]}
 *
 * @typedef {{effect: {id: string, uuid?: string, name?: string}, rules: object, conditionId?: string | null,
 *   situationalId?: string | null, stanceId?: string | null, value?: object | null, onActor?: boolean}} Row
 *   stanceId: the talent id a stance marker stands for (scripts/stances.js);
 *   onActor: false for an effect one of the actor's items transfers to it (never used up by a test)
 * @typedef {{key: string, modeKey: string, label: string, rules: object, effectId?: string, value?: object | null}} Source
 *   key: what counts once: the condition id for a condition (several instances of one condition count once),
 *     `stance:<talent id>` for a stance, otherwise the effect (its uuid, else its id);
 *   modeKey: the modifier's key, which `modeOf` reads: the condition id, `situational:<id>` for the situational
 *     table's entries (stances included), `effect:<effect id>` for any other effect;
 *   label: the table's name for the tables' entries, the effect's own name for any other effect;
 *   effectId: the effect a `consume` rule ends (absent for an effect an item transfers)
 */
export function rollSources(rows, { conditions, situational }) {
    const out = [];
    for (const { effect, rules, conditionId, situationalId, stanceId, value, onActor } of rows ?? []) {
        if (!rules?.rolls?.length) continue;
        // An effect an item transfers lives on the item: it is not the actor's to use up.
        const base = { rules, value: value ?? null, ...(onActor === false ? {} : { effectId: effect.id }) };
        const name = effect.name ?? effect.id;
        if (conditionId) {
            out.push({ ...base, key: conditionId, modeKey: conditionId, label: conditions[conditionId]?.name ?? name });
        } else if (situationalId) {
            out.push({ ...base, key: effect.uuid ?? effect.id, modeKey: situationalKey(situationalId), label: situational[situationalId]?.name ?? name });
        } else if (stanceId) {
            const entry = stanceEntry(stanceId, situational);
            out.push({
                ...base,
                key: `stance:${stanceId}`,
                modeKey: entry ? situationalKey(entry.id) : effectKey(effect.id),
                label: entry?.name ?? name,
            });
        } else {
            out.push({ ...base, key: effect.uuid ?? effect.id, modeKey: effectKey(effect.id), label: name });
        }
    }
    return out;
}

/**
 * The source a stance gives from the table alone, for an actor in a stance with no marker effect to carry it
 * (stances not in full mode, or the stance set by something other than this module).
 * @param {string | null | undefined} stanceId the actor's stance (the talent's system id)
 * @param {Record<string, object>} situational the situational table by id
 * @returns {Source | null}
 */
export function stanceSource(stanceId, situational) {
    const entry = stanceEntry(stanceId, situational);
    if (!entry) return null;
    const rules = defaultRules(entry);
    if (!rules.rolls?.length) return null;
    return { key: `stance:${stanceId}`, modeKey: situationalKey(entry.id), label: entry.name, rules, value: null };
}

/**
 * Every source of one side: its effects' (`rollSources`), and its stance's from the table when no marker effect
 * stands for that stance. A marker counts only for the stance the actor is in (one left over from another stance
 * is ignored), and then its rules decide, even when its own rules turn the stance's roll rules off.
 * @param {Row[]} rows the actor's effects, those with no rules included (`ruleEffects(actor, {includeEmpty: true})`)
 * @param {{stance?: string | null, conditions: Record<string, object>, situational: Record<string, object>}} options
 *   stance: the actor's stance (the talent's system id), if any
 * @returns {Source[]}
 */
export function sideSources(rows, { stance = null, conditions, situational }) {
    const current = (rows ?? []).filter((row) => !row.stanceId || row.stanceId === stance);
    const sources = rollSources(current, { conditions, situational });
    if (stance && !current.some((row) => row.stanceId === stance)) {
        const fromTable = stanceSource(stance, situational);
        if (fromTable) sources.push(fromTable);
    }
    return sources;
}

/**
 * The statuses a side has, for the facts of a test (`self:condition:<id>`): every table condition among its
 * effects, whether or not it has roll rules, and every other status id its effects carry (`effect.statuses`),
 * so a rule can ask for a homebrew status. The rows are the enabled, unsuppressed effects (`ruleEffects`).
 * @param {Row[]} rows the actor's effects, those with no rules included
 * @returns {string[]} status ids, no repeats
 */
export function sideConditions(rows) {
    const ids = new Set();
    for (const row of rows ?? []) {
        if (row.conditionId) ids.add(row.conditionId);
        for (const id of row.effect?.statuses ?? []) if (typeof id === 'string' && id) ids.add(id);
    }
    return [...ids];
}

/**
 * Collect the modifiers that apply to a test.
 *
 * @param {object} input
 * @param {Side} input.roller
 * @param {Side | null} input.target  the roller's single target, or null
 * @param {{context: string, skill?: string | null, attackType?: string | null, beyondSenses?: boolean | null}} input.test
 * @param {object} options
 * @param {(key: string) => 'full' | 'remind' | 'off'} options.modeOf  mode of a source's `modeKey`
 * @returns {Modifier[]}
 *
 * @typedef {{ uuid: string, name: string, sources: Source[], conditions?: string[], stance?: string | null }} Side
 *   conditions, stance: what the facts of the test say about this side (`rollFacts`); a side without them only
 *   gives the `is` fact
 * @typedef {{ key: string, label: string, mode: string, active: boolean, side: 'self' | 'target',
 *   consume?: {actorUuid: string, effectId: string} }} Modifier
 *   key: the source's `modeKey`; active: false when the source is in remind-only mode (shown, not applied)
 */
export function collectModifiers({ roller, target, test }, { modeOf }) {
    const out = [];
    // One set of facts for the whole test: every rule of both sides is judged against it.
    const facts = rollFacts({ roller, target, test });
    const sides = [
        ['self', roller],
        ['target', target],
    ];
    for (const [who, side] of sides) {
        if (!side) continue;
        const seen = new Set();
        for (const source of side.sources ?? []) {
            if (seen.has(source.key)) continue; // several instances of a condition count once
            seen.add(source.key);
            for (const rule of source.rules?.rolls ?? []) {
                // `vsTarget` (Advantage gained) reads the enemy stored in the effect's value.
                if (rule.who !== who || !ruleApplies(rule, facts, source.value)) continue;
                const mode = modeOf(source.modeKey);
                if (mode === 'off') continue;
                const targetName = rule.vsTarget ? source.value?.targetName : null;
                const mod = {
                    key: source.modeKey,
                    label: targetName ? `${source.label} (${targetName})` : source.label,
                    mode: rule.mode,
                    active: mode === 'full',
                    side: who,
                };
                if (rule.consume && source.effectId) mod.consume = { actorUuid: side.uuid, effectId: source.effectId };
                out.push(mod);
            }
        }
    }
    return out;
}

/**
 * Whether any of a side's roll rules asks if the target is beyond the roller's senses (Senseblind's `beyondSenses`,
 * or a `when` that names the fact), so the glue only measures the distance when something reads it.
 * @param {Side | null} side
 * @param {'self' | 'target'} [who] the rules that count for this side: 'self' for the roller, 'target' for its target
 */
export function needsSensesRange(side, who = 'self') {
    return !!side?.sources?.some((source) =>
        source.rules?.rolls?.some((rule) => rule.who === who && factsIn(rulePredicate(rule, source.value)).has(FACT.BEYOND_SENSES)),
    );
}

/**
 * The term that adds a skill's engine modifiers back to a test that left them out: `0 - 2` for a penalty of 2,
 * `0 + 1` for a bonus of 1 (a penalty of -1), null for none.
 * @param {number} penalty what the engine takes off the skill (`skillPenalty`; negative for a bonus)
 * @returns {string | null}
 */
export function skillPenaltyFormula(penalty) {
    if (!Number.isFinite(penalty) || penalty === 0) return null;
    return penalty > 0 ? `0 - ${penalty}` : `0 + ${-penalty}`;
}

/**
 * Net the roller's own choice and the active modifiers into one mode.
 * @param {string} base the mode chosen by the caller (keyboard, macro, dialog default): counts as one
 * @param {{mode: string, active: boolean}[]} modifiers
 */
export function netMode(base, modifiers) {
    let score = base === ADV ? 1 : base === DIS ? -1 : 0;
    for (const mod of modifiers) {
        if (!mod.active) continue;
        score += mod.mode === ADV ? 1 : -1;
    }
    return score > 0 ? ADV : score < 0 ? DIS : NONE;
}

/**
 * A short line for the chat card: "Disadvantage: Restrained. Advantage: target Prone (melee). Reminder only: …"
 * @param {{label: string, mode: string, active: boolean, side: string}[]} modifiers
 */
export function describeModifiers(modifiers) {
    const fmt = (m) => (m.side === 'target' ? `target ${m.label}` : m.label);
    const parts = [];
    const adv = modifiers.filter((m) => m.active && m.mode === ADV).map(fmt);
    const dis = modifiers.filter((m) => m.active && m.mode === DIS).map(fmt);
    const remind = modifiers.filter((m) => !m.active).map((m) => `${fmt(m)} (${m.mode})`);
    if (adv.length) parts.push(`Advantage: ${adv.join(', ')}.`);
    if (dis.length) parts.push(`Disadvantage: ${dis.join(', ')}.`);
    if (remind.length) parts.push(`Not applied (remind only): ${remind.join(', ')}.`);
    return parts.join(' ');
}
