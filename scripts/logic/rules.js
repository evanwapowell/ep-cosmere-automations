/**
 * Rules an effect can carry, schema 1: the shape, its validator and the converter from a table entry.
 * Pure functions, no Foundry globals. See "Rules on effects" in DESIGN.md.
 *
 * An effect's own rules live in `flags['ep-cosmere-automations'].rules`:
 *
 *   {
 *     schema: 1,
 *     mechanics: [
 *       { kind: 'movement', op: 'zero' | 'half' },
 *       { kind: 'skillModifier', amount: -1, perStack: true, skills: 'all' | ['prc', …] },
 *       { kind: 'attributeBonus', from: 'value' },            // attribute and amount from the effect's value
 *       { kind: 'attributeBonus', attribute: 'str', amount: 1 },
 *     ],
 *     rolls: [{ who, mode, tests, when?, beyondSenses?, vsTarget?, consume? }],   // see data/conditions.js
 *     links: ['slowed'],                       // conditions it brings with it
 *     longRest: 1,                             // stacks a long rest takes off
 *     endsWhen: ['attack', 'move'],            // ends when its bearer does this
 *     duration: ['untilUsed', 'endOfScene'],   // default duration; { kinds, days } when it counts days
 *   }
 *
 * Every field is optional. A field that is not set (missing or null) means "use the table's default for this
 * effect, if it has one". A field that is set replaces the default as a whole; to say "none of this kind", set it
 * to an empty list (`longRest: 0`).
 */
import { MECHANICS } from '../../data/conditions.js';
import { KINDS, parseDurationSpec } from './durations.js';
import { parsePredicate } from './predicates.js';
import { ruleProblems } from './rolls.js';

/** The schema this version reads and writes. Rules without a `schema` field are schema 1. */
export const RULES_SCHEMA = 1;

/** Every field rules may have. */
export const RULE_FIELDS = Object.freeze(['schema', 'mechanics', 'rolls', 'links', 'longRest', 'endsWhen', 'duration']);

/** Kinds of mechanic records. */
export const MECHANIC_KINDS = Object.freeze({
    /** Changes every movement rate: `op: 'zero'` or `op: 'half'` (rounded down, after everything else). */
    MOVEMENT: 'movement',
    /** Adds `amount` to skill modifiers: all of them or the listed skills; times the effect's stacks with `perStack`. */
    SKILL_MODIFIER: 'skillModifier',
    /** Adds to one attribute's bonus (skills, movement, senses; not defenses or maximum resources). */
    ATTRIBUTE_BONUS: 'attributeBonus',
});

export const MOVEMENT_OPS = Object.freeze(['zero', 'half']);

/** What can end an effect when its bearer does it. */
export const ENDS_WHEN = Object.freeze(['attack', 'move']);

/** The table's mechanic names (`MECHANICS` in data/conditions.js) as records. */
export const MECHANIC_RECORDS = Object.freeze({
    [MECHANICS.NO_MOVEMENT]: Object.freeze({ kind: MECHANIC_KINDS.MOVEMENT, op: 'zero' }),
    [MECHANICS.HALF_MOVEMENT]: Object.freeze({ kind: MECHANIC_KINDS.MOVEMENT, op: 'half' }),
    [MECHANICS.SKILL_PENALTY_PER_STACK]: Object.freeze({ kind: MECHANIC_KINDS.SKILL_MODIFIER, amount: -1, perStack: true, skills: 'all' }),
    [MECHANICS.ATTRIBUTE_BONUS]: Object.freeze({ kind: MECHANIC_KINDS.ATTRIBUTE_BONUS, from: 'value' }),
});

const ROLL_FLAGS = Object.freeze(['beyondSenses', 'vsTarget', 'consume']);
const ROLL_KEYS = Object.freeze(['who', 'mode', 'tests', 'when', ...ROLL_FLAGS]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' && value.length > 0;
const isAmount = (value) => Number.isInteger(value) && value !== 0;
const show = (value) => JSON.stringify(value) ?? String(value);
const extraKeys = (record, allowed) => Object.keys(record).filter((key) => !allowed.includes(key));
const unknownFields = (keys) => `unknown field${keys.length > 1 ? 's' : ''} ${keys.map(show).join(', ')}`;

/*
 * The parsers below report problems through `fail(message)` (which returns undefined) and return the clean
 * value. After any problem `parseRules` returns no rules, so a parser only has to keep going without throwing.
 */

/** A list of ids (skills, conditions): non-empty strings, each one known when the valid ids were given. */
function parseIds(list, what, knownIds, fail) {
    if (!Array.isArray(list)) return fail(`must be a list of ${what} ids`);
    for (const id of list) {
        if (!isId(id)) fail(`${show(id)} is not a ${what} id`);
        else if (knownIds && !knownIds.has(id)) fail(`unknown ${what} ${show(id)}`);
    }
    return [...new Set(list)];
}

/** One parser per mechanic kind: the `keys` a record may have besides `kind`, and `parse` → the clean record. */
const MECHANIC_PARSERS = Object.freeze({
    [MECHANIC_KINDS.MOVEMENT]: {
        keys: ['op'],
        parse(record, known, fail) {
            if (!MOVEMENT_OPS.includes(record.op)) fail(`unknown op ${show(record.op)} (known: ${MOVEMENT_OPS.join(', ')})`);
            return { kind: record.kind, op: record.op };
        },
    },
    [MECHANIC_KINDS.SKILL_MODIFIER]: {
        keys: ['amount', 'perStack', 'skills'],
        parse(record, known, fail) {
            if (!isAmount(record.amount)) fail('amount must be a whole number other than 0');
            if (record.perStack != null && typeof record.perStack !== 'boolean') fail('perStack must be true or false');
            let skills = 'all';
            if (record.skills != null && record.skills !== 'all') {
                skills = parseIds(record.skills, 'skill', known.skills, (message) => fail(`skills: ${message}`));
                if (skills?.length === 0) fail('skills: an empty list changes nothing; use "all" or list skill ids');
            }
            return { kind: record.kind, amount: record.amount, perStack: record.perStack === true, skills };
        },
    },
    [MECHANIC_KINDS.ATTRIBUTE_BONUS]: {
        keys: ['from', 'attribute', 'amount'],
        parse(record, known, fail) {
            if (record.from != null) {
                if (record.from !== 'value') fail(`unknown from ${show(record.from)} (known: "value")`);
                if (record.attribute != null || record.amount != null) fail('give either from: "value" or attribute and amount, not both');
                return { kind: record.kind, from: 'value' };
            }
            if (!isId(record.attribute)) fail('needs an attribute id and an amount, or from: "value"');
            else if (known.attributes && !known.attributes.has(record.attribute)) fail(`unknown attribute ${show(record.attribute)}`);
            if (!isAmount(record.amount)) fail('amount must be a whole number other than 0');
            return { kind: record.kind, attribute: record.attribute, amount: record.amount };
        },
    },
});

function parseMechanic(record, known, fail) {
    if (!isRecord(record)) return fail('must be an object like { kind: "movement", op: "half" }');
    if (!Object.hasOwn(MECHANIC_PARSERS, record.kind)) {
        return fail(`unknown kind ${show(record.kind)} (known: ${Object.keys(MECHANIC_PARSERS).join(', ')})`);
    }
    const parser = MECHANIC_PARSERS[record.kind];
    const extra = extraKeys(record, ['kind', ...parser.keys]);
    if (extra.length) fail(`${unknownFields(extra)} for kind "${record.kind}"`);
    return parser.parse(record, known, fail);
}

function parseRoll(rule, known, fail) {
    const errors = ruleProblems(rule, known);
    if (errors.length) return void errors.forEach(fail);
    const extra = extraKeys(rule, ROLL_KEYS);
    if (extra.length) fail(unknownFields(extra));
    // A rule with a `when` may leave `tests` out; it then covers every test.
    const clean = { who: rule.who, mode: rule.mode, tests: rule.tests ?? 'all' };
    if (isRecord(rule.tests)) {
        const extraTests = extraKeys(rule.tests, ['skills']);
        if (extraTests.length) fail(`tests: ${unknownFields(extraTests)}`);
        clean.tests = { skills: parseIds(rule.tests.skills, 'skill', known.skills, (message) => fail(`tests.skills: ${message}`)) };
    }
    for (const flag of ROLL_FLAGS) {
        if (rule[flag] != null && typeof rule[flag] !== 'boolean') fail(`${flag} must be true or false`);
        if (rule[flag] === true) clean[flag] = true;
    }
    if (rule.when?.length) clean.when = parsePredicate(rule.when, known).when; // a clean copy: it was just checked
    return clean;
}

/** The kinds of a normalized duration (a list of kinds, or {kinds, days}). */
const durationKinds = (duration) => (Array.isArray(duration) ? duration : (duration?.kinds ?? []));

/**
 * The default duration: anything `parseDurationSpec` takes, except that an object may only have `kinds` and `days`.
 * @returns {string[] | {kinds: string[], days: number} | undefined} a list of kinds, or {kinds, days} with 'days'
 */
function parseDuration(spec, fail) {
    let kinds = spec;
    if (isRecord(spec)) {
        const extra = extraKeys(spec, ['kinds', 'days']);
        if (extra.length) fail(unknownFields(extra));
        if (spec.days != null && typeof spec.days !== 'number') return fail('days must be a number');
        kinds = spec.kinds;
    }
    if (typeof kinds === 'string') kinds = [kinds];
    if (!Array.isArray(kinds)) return fail('must be a duration kind, a list of kinds or { kinds, days }');
    const notKind = kinds.find((kind) => typeof kind !== 'string');
    if (notKind !== undefined) return fail(`${show(notKind)} is not a duration kind`);

    const parsed = parseDurationSpec(spec);
    if (!parsed.ok) return fail(parsed.error);
    if (parsed.kinds.includes(KINDS.DAYS)) return { kinds: parsed.kinds, days: parsed.days };
    if (spec.days != null) fail(`days is only for the "${KINDS.DAYS}" kind`);
    return parsed.kinds;
}

/**
 * Check rules and build their clean copy in one pass.
 *
 * Strict on purpose: an unknown field or kind is a problem, not something to skip. Rules written for a later
 * version may qualify a rule in a way this version can't read, and applying the rule without its qualifier would
 * be wrong; with a problem reported, the caller falls back to the table's defaults instead.
 *
 * @param {unknown} rules the value of the effect's `rules` flag
 * @param {{conditions?: Iterable<string>, skills?: Iterable<string>, attributes?: Iterable<string>}} [known]
 *   valid ids, when known (links, skills and attributes are then checked against them)
 * @returns {{ok: true, rules: Rules | null, problems: string[]} | {ok: false, rules: null, problems: string[]}}
 *   `rules` is null when there are none (null or undefined) or when there are problems
 *
 * @typedef {object} Rules normalized rules; a field that is absent is not set
 * @property {1} schema
 * @property {object[]} [mechanics] records, every optional part filled in (`perStack`, `skills`)
 * @property {object[]} [rolls] roll rules; `tests` always set ('all' when left out), the flags `beyondSenses`,
 *   `vsTarget`, `consume` only when true, `when` only when it has terms
 * @property {string[]} [links] condition ids, no repeats
 * @property {number} [longRest] whole number ≥ 0
 * @property {string[]} [endsWhen] no repeats
 * @property {string[] | {kinds: string[], days: number}} [duration] a list of kinds; {kinds, days} with 'days'
 */
export function parseRules(rules, known = {}) {
    const problems = [];
    if (rules == null) return { ok: true, rules: null, problems };
    const invalid = () => ({ ok: false, rules: null, problems });
    /** Report a problem at a path; the reporter returns undefined so a parser can `return fail(…)`. */
    const failAt = (path) => (message) => void problems.push(`${path}: ${message}`);

    if (!isRecord(rules)) {
        problems.push('rules must be an object');
        return invalid();
    }
    const schema = rules.schema ?? RULES_SCHEMA;
    if (schema !== RULES_SCHEMA) {
        const newer = Number.isInteger(schema) && schema > RULES_SCHEMA ? '; these rules were written for a newer version' : '';
        failAt('schema')(`unsupported value ${show(schema)} (this version of the module reads schema ${RULES_SCHEMA}${newer})`);
        return invalid(); // the fields of another schema can't be judged by this one
    }
    const extra = extraKeys(rules, RULE_FIELDS);
    if (extra.length) problems.push(`${unknownFields(extra)} (known: ${RULE_FIELDS.join(', ')})`);

    const knownSets = Object.fromEntries(
        ['conditions', 'skills', 'attributes'].map((key) => [key, known?.[key] ? new Set(known[key]) : null]),
    );
    /** A list field: its array, or null when it is not set or (reported) not a list. */
    const listOf = (field) => {
        if (rules[field] == null) return null;
        if (Array.isArray(rules[field])) return rules[field];
        return failAt(field)('must be a list ([] for none)') ?? null;
    };
    const clean = { schema: RULES_SCHEMA };

    const mechanics = listOf('mechanics');
    if (mechanics) clean.mechanics = mechanics.map((record, i) => parseMechanic(record, knownSets, failAt(`mechanics[${i}]`)));
    const rolls = listOf('rolls');
    if (rolls) clean.rolls = rolls.map((rule, i) => parseRoll(rule, knownSets, failAt(`rolls[${i}]`)));
    const links = listOf('links');
    if (links) clean.links = parseIds(links, 'condition', knownSets.conditions, failAt('links'));
    if (rules.longRest != null) {
        if (!(Number.isInteger(rules.longRest) && rules.longRest >= 0)) failAt('longRest')('must be a whole number of stacks, 0 or more');
        clean.longRest = rules.longRest;
    }
    const endsWhen = listOf('endsWhen');
    if (endsWhen) {
        for (const trigger of endsWhen) {
            if (!ENDS_WHEN.includes(trigger)) failAt('endsWhen')(`unknown trigger ${show(trigger)} (known: ${ENDS_WHEN.join(', ')})`);
        }
        clean.endsWhen = [...new Set(endsWhen)];
    }
    if (rules.duration != null) clean.duration = parseDuration(rules.duration, failAt('duration'));

    return problems.length ? invalid() : { ok: true, rules: clean, problems };
}

/**
 * Check an effect's rules. Returns a list of problems (empty when valid; no rules at all is valid).
 * @param {unknown} rules
 * @param {{conditions?: Iterable<string>, skills?: Iterable<string>, attributes?: Iterable<string>}} [known]
 * @returns {string[]}
 */
export function validateRules(rules, known) {
    return parseRules(rules, known).problems;
}

/**
 * A clean copy of valid rules: `schema` set, optional parts of records filled in, repeats dropped, nothing shared
 * with the input. Normalizing the result again gives the same thing.
 * @param {unknown} rules
 * @returns {Rules | null} null when there are no rules or they are not valid (see `validateRules`)
 */
export function normalizeRules(rules) {
    return parseRules(rules).rules;
}

/**
 * Whether normalized rules say anything at all: an effect whose resolved rules are empty can be skipped.
 * @param {Rules | null | undefined} rules
 */
export function hasRules(rules) {
    if (!rules) return false;
    return (
        ['mechanics', 'rolls', 'links', 'endsWhen'].some((field) => rules[field]?.length > 0) ||
        rules.longRest > 0 ||
        durationKinds(rules.duration).length > 0
    );
}

/**
 * The rules a table entry stands for (data/conditions.js or data/situational.js): the defaults of the effects
 * that entry describes. Only what the entry gives is set; in defaults, "none" and "not set" mean the same.
 * @param {object | null | undefined} entry
 * @returns {Rules} normalized rules; just `{schema}` for an entry with no rules, or for no entry
 * @throws {Error} when the entry is not valid (a mistake in the module's own tables, caught by the tests)
 */
export function entryToRules(entry) {
    const raw = { schema: RULES_SCHEMA };
    if (!entry) return raw;
    if (entry.mechanics?.length) {
        raw.mechanics = entry.mechanics.map((name) => {
            if (!Object.hasOwn(MECHANIC_RECORDS, name)) throw new Error(`${entry.id}: no rule record for mechanic ${show(name)}`);
            return MECHANIC_RECORDS[name];
        });
    }
    for (const field of ['rolls', 'links', 'endsWhen']) if (entry[field]?.length) raw[field] = entry[field];
    if (entry.longRest) raw.longRest = entry.longRest;
    if (entry.duration != null) raw.duration = entry.duration;

    const parsed = parseRules(raw);
    if (!parsed.ok) throw new Error(`${entry.id}: ${parsed.problems.join('; ')}`);
    if (!durationKinds(parsed.rules.duration).length) delete parsed.rules.duration;
    return parsed.rules;
}

/**
 * The rules a table entry stands for (`entryToRules`), for callers that may have no resolved rules to hand. Not
 * remembered: the table is read as it is now, and an entry is a few records, cheap to convert.
 * @param {object | null | undefined} entry
 * @returns {Rules}
 */
export function defaultRules(entry) {
    return entryToRules(entry);
}

/** The fields rules can leave unset, which resolve one by one (everything but `schema`). */
const RESOLVED_FIELDS = RULE_FIELDS.filter((field) => field !== 'schema');

/**
 * The rules an effect has: its own, field by field, over the table's defaults. See "Defaults and overrides" in
 * DESIGN.md.
 *
 * - A field the effect's own rules set (even to an empty list or 0) replaces the default as a whole.
 * - A field it doesn't set takes the default of `defaultEntry`, if there is one.
 * - Own rules with any problem are ignored entirely (never part of them), and the problems are reported so the
 *   caller can warn; the defaults then apply.
 *
 * @param {unknown} ownRules the value of the effect's `rules` flag
 * @param {object | null | undefined} defaultEntry the table entry (data/conditions.js or data/situational.js)
 *   whose rules are the defaults for this effect, if any
 * @param {object} [known] valid ids, as for `parseRules`
 * @returns {{rules: Rules, problems: string[]}} `rules` is read-only (it may share lists with the defaults);
 *   `problems` is empty unless the effect's own rules were ignored
 */
export function resolveRules(ownRules, defaultEntry, known) {
    const own = parseRules(ownRules, known);
    const defaults = defaultRules(defaultEntry);
    const rules = { schema: RULES_SCHEMA };
    for (const field of RESOLVED_FIELDS) {
        const value = own.rules?.[field] ?? defaults[field];
        if (value !== undefined) rules[field] = value;
    }
    return { rules, problems: own.problems };
}

/**
 * The default duration of resolved rules, as `buildDuration` takes it; undefined when there is none.
 * @param {Rules | null | undefined} rules
 * @returns {string[] | {kinds: string[], days: number} | undefined}
 */
export function defaultDuration(rules) {
    return durationKinds(rules?.duration).length ? rules.duration : undefined;
}

/**
 * Where an effect's rules come from, for authoring (the API's `rules(effect)` and the Rules dialog): the resolved
 * rules, the effect's own and the table's defaults side by side, and for each resolved field whether the effect or
 * the defaults gave it.
 * @param {unknown} ownRules the value of the effect's `rules` flag
 * @param {object | null | undefined} defaultEntry as for `resolveRules`
 * @param {object} [known] valid ids, as for `parseRules`
 * @returns {{rules: Rules, own: Rules | null, defaults: Rules, from: Record<string, 'effect' | 'default'>,
 *   problems: string[]}} own: the effect's own rules, normalized (null when it has none, or they are invalid);
 *   from: one entry per field `rules` has, besides `schema`; problems: why its own rules are ignored, if they are
 */
export function explainRules(ownRules, defaultEntry, known) {
    const own = parseRules(ownRules, known);
    const { rules, problems } = resolveRules(ownRules, defaultEntry, known);
    const from = {};
    for (const field of RESOLVED_FIELDS) {
        if (rules[field] === undefined) continue;
        from[field] = own.rules?.[field] != null ? 'effect' : 'default';
    }
    return { rules, own: own.rules, defaults: defaultRules(defaultEntry), from, problems };
}
