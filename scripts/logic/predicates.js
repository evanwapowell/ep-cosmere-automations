/**
 * Predicates for roll rules: the facts a test exposes, and `when`, a condition over those facts.
 * Pure functions, no Foundry globals. See "Predicates on roll rules" in DESIGN.md.
 *
 * Facts are flat strings, built once per test from the test and its two sides (`rollFacts`). `self` is always
 * the one making the test and `target` the one it is made against, whichever of the two carries the rule:
 *
 *   test:attack                     the test is an attack test
 *   test:skill:<skill id>           the skill the test uses (an attack's weapon skill too)
 *   attack:melee | attack:ranged    the kind of attack, when it is known
 *   self:condition:<condition id>   the roller has that condition (an id of the condition table)
 *   self:stance:<stance id>         the roller is in that stance (the stance talent's system id)
 *   self:is:<actor uuid>            who the roller is
 *   target:condition:<id>, target:stance:<id>, target:is:<uuid>     the same for the roller's single target
 *   target:beyond-senses            the target was measured to be farther away than the roller's senses reach
 *
 * A fact that isn't known to be true is simply not there: no target, a distance that couldn't be measured and a
 * misspelt id all read as false.
 *
 * `when` is a list of terms that must all hold. A term is one of:
 *
 *   'test:attack'                   a fact: holds when the test has it
 *   { or: [term, …] }               holds when any of them does
 *   { not: term }                   holds when it doesn't
 *   [term, …]                       a list inside another term: holds when all of them do
 */

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' && value.length > 0;
const show = (value) => JSON.stringify(value) ?? String(value);
const toSet = (ids) => (ids == null ? null : ids instanceof Set ? ids : new Set(ids));

/** The two sides of a test, as facts name them (and as a rule's `who` does). */
export const FACT_SIDES = Object.freeze(['self', 'target']);

/** The kinds of attack a fact can name. */
export const ATTACK_TYPES = Object.freeze(['melee', 'ranged']);

/** How deep terms may nest. Far more than a rule written by hand needs; it keeps a walk over bad data short. */
export const MAX_DEPTH = 8;

/** The one place that spells a fact. */
export const FACT = Object.freeze({
    ATTACK: 'test:attack',
    BEYOND_SENSES: 'target:beyond-senses',
    skill: (id) => `test:skill:${id}`,
    attackType: (type) => `attack:${type}`,
    condition: (side, id) => `${side}:condition:${id}`,
    stance: (side, id) => `${side}:stance:${id}`,
    is: (side, uuid) => `${side}:is:${uuid}`,
});

/** Every shape a fact can have, for the validator's message and the docs. */
export const FACT_SHAPES = Object.freeze([
    'test:attack',
    'test:skill:<skill id>',
    'attack:melee',
    'attack:ranged',
    'self:condition:<condition id>',
    'self:stance:<stance id>',
    'self:is:<actor uuid>',
    'target:condition:<condition id>',
    'target:stance:<stance id>',
    'target:is:<actor uuid>',
    'target:beyond-senses',
]);

/** A term that never holds (an empty "or"): what a shorthand compiles to when it can't apply. */
export const NEVER = Object.freeze({ or: Object.freeze([]) });

/**
 * The facts of one test.
 *
 * @param {object} situation
 * @param {FactSide | null} [situation.roller] the one making the test
 * @param {FactSide | null} [situation.target] its single target, or null (none, or several)
 * @param {{context?: string, skill?: string | null, attackType?: string | null, beyondSenses?: boolean | null}} [situation.test]
 *   context: the system's roll context ('Skill', 'Item', 'Attack'); beyondSenses: true when the target was
 *   measured to be beyond the roller's senses range (null or missing: not measured)
 * @returns {Set<string>}
 *
 * @typedef {{uuid?: string, conditions?: Iterable<string>, stance?: string | null}} FactSide
 *   conditions: the ids of the table conditions it has; stance: the stance it is in
 */
export function rollFacts({ roller = null, target = null, test = null } = {}) {
    const facts = new Set();
    const isAttack = test?.context === 'Attack';
    if (isAttack) facts.add(FACT.ATTACK);
    if (isId(test?.skill)) facts.add(FACT.skill(test.skill));
    if (isAttack && ATTACK_TYPES.includes(test.attackType)) facts.add(FACT.attackType(test.attackType));
    if (test?.beyondSenses === true) facts.add(FACT.BEYOND_SENSES);

    const sides = [
        ['self', roller],
        ['target', target],
    ];
    for (const [name, side] of sides) {
        if (!side) continue;
        if (isId(side.uuid)) facts.add(FACT.is(name, side.uuid));
        if (isId(side.stance)) facts.add(FACT.stance(name, side.stance));
        for (const id of side.conditions ?? []) if (isId(id)) facts.add(FACT.condition(name, id));
    }
    return facts;
}

function evaluate(term, facts, depth) {
    if (typeof term === 'string') return facts.has(term);
    if (term === null || typeof term !== 'object' || depth > MAX_DEPTH) return false;
    if (Array.isArray(term)) return term.every((part) => evaluate(part, facts, depth + 1));
    if (Array.isArray(term.or)) return term.or.some((part) => evaluate(part, facts, depth + 1));
    if (Object.hasOwn(term, 'not')) return !evaluate(term.not, facts, depth + 1);
    return false;
}

/**
 * Whether a predicate holds for a set of facts. It never throws: a fact that isn't in the set is false, and so is
 * anything that isn't a term at all (`validatePredicate` is what refuses those before they are stored).
 * @param {unknown} when a list of terms that must all hold; none (null, undefined or an empty list) always holds
 * @param {Iterable<string>} facts the facts of the test (`rollFacts`)
 * @returns {boolean}
 */
export function holds(when, facts) {
    if (when == null) return true;
    return evaluate(when, facts instanceof Set ? facts : new Set(facts ?? []), 0);
}

/**
 * Every fact a predicate names, wherever it is nested.
 * @param {unknown} when
 * @returns {Set<string>}
 */
export function factsIn(when) {
    const out = new Set();
    const walk = (term, depth) => {
        if (typeof term === 'string') out.add(term);
        else if (term === null || typeof term !== 'object' || depth > MAX_DEPTH) return;
        else if (Array.isArray(term)) for (const part of term) walk(part, depth + 1);
        else if (Array.isArray(term.or)) for (const part of term.or) walk(part, depth + 1);
        else if (Object.hasOwn(term, 'not')) walk(term.not, depth + 1);
    };
    walk(when, 0);
    return out;
}

/** What is wrong with a fact, or null. Ids are checked against `known` only where it lists them. */
function factProblem(fact, known) {
    if (fact === FACT.ATTACK || fact === FACT.BEYOND_SENSES) return null;
    const [head, kind, ...rest] = fact.split(':');
    const id = rest.join(':');
    if (head === 'attack' && ATTACK_TYPES.includes(kind) && !rest.length) return null;
    if (head === 'test' && kind === 'skill' && id) {
        return known.skills && !known.skills.has(id) ? `unknown skill ${show(id)} in ${show(fact)}` : null;
    }
    if (FACT_SIDES.includes(head) && id) {
        if (kind === 'condition') {
            return known.conditions && !known.conditions.has(id) ? `unknown condition ${show(id)} in ${show(fact)}` : null;
        }
        if (kind === 'stance' || kind === 'is') return null;
    }
    return `unknown fact ${show(fact)} (known: ${FACT_SHAPES.join(', ')})`;
}

/** Check one term and build its clean copy. `fail(message)` reports a problem and returns undefined. */
function parseTerm(term, path, depth, known, fail) {
    if (typeof term === 'string') {
        const problem = factProblem(term, known);
        if (problem) fail(`${path}: ${problem}`);
        return term;
    }
    if (depth > MAX_DEPTH) return fail(`${path}: nested more than ${MAX_DEPTH} deep`);
    if (Array.isArray(term)) {
        if (!term.length) fail(`${path}: an empty list always holds; leave it out`);
        return term.map((part, i) => parseTerm(part, `${path}[${i}]`, depth + 1, known, fail));
    }
    if (isRecord(term)) {
        const keys = Object.keys(term);
        if (keys.length === 1 && keys[0] === 'or') {
            if (!Array.isArray(term.or)) return fail(`${path}.or: must be a list of terms`);
            if (!term.or.length) fail(`${path}.or: an empty "or" never holds`);
            return { or: term.or.map((part, i) => parseTerm(part, `${path}.or[${i}]`, depth + 1, known, fail)) };
        }
        if (keys.length === 1 && keys[0] === 'not') return { not: parseTerm(term.not, `${path}.not`, depth + 1, known, fail) };
    }
    return fail(`${path}: ${show(term)} is not a term; use a fact like "test:attack", { or: [...] }, { not: ... } or a list`);
}

/**
 * Check a `when` and build its clean copy in one pass.
 * @param {unknown} when
 * @param {{conditions?: Iterable<string> | null, skills?: Iterable<string> | null}} [known] valid ids, when known
 *   (the condition and skill ids facts name are then checked against them)
 * @returns {{when: unknown[] | null, problems: string[]}} `when` is null when there are problems; the problems
 *   say where (`when[1].or[0]: unknown fact "target:prone" (known: …)`)
 */
export function parsePredicate(when, known = {}) {
    const problems = [];
    if (!Array.isArray(when)) {
        problems.push('when: must be a list of terms that all have to hold, like ["test:attack", "target:condition:prone"]');
        return { when: null, problems };
    }
    const knownSets = { conditions: toSet(known?.conditions), skills: toSet(known?.skills) };
    const fail = (message) => void problems.push(message);
    const clean = when.map((term, i) => parseTerm(term, `when[${i}]`, 1, knownSets, fail));
    return { when: problems.length ? null : clean, problems };
}

/**
 * Check a `when`. Returns a list of problems (empty when valid).
 * @param {unknown} when
 * @param {{conditions?: Iterable<string> | null, skills?: Iterable<string> | null}} [known]
 * @returns {string[]}
 */
export function validatePredicate(when, known) {
    return parsePredicate(when, known).problems;
}

/**
 * What a rule's `tests` shorthand says, as terms.
 * @param {'all' | 'attack' | 'melee' | 'ranged' | {skills: string[]}} tests
 * @returns {unknown[]}
 */
export function testsPredicate(tests) {
    if (tests === 'all') return [];
    if (tests === 'attack') return [FACT.ATTACK];
    if (ATTACK_TYPES.includes(tests)) return [FACT.ATTACK, FACT.attackType(tests)];
    if (Array.isArray(tests?.skills) && tests.skills.length) {
        const skills = tests.skills.map(FACT.skill);
        return skills.length === 1 ? skills : [{ or: skills }];
    }
    return [NEVER];
}

/**
 * The whole condition of a roll rule as one predicate: its shorthand fields compiled, then its own `when`.
 *
 *   tests: 'all'            → nothing
 *   tests: 'attack'         → 'test:attack'
 *   tests: 'melee'          → 'test:attack', 'attack:melee'   (the same for 'ranged')
 *   tests: { skills: […] }  → 'test:skill:<id>', or { or: [one per skill] }
 *   beyondSenses: true      → 'target:beyond-senses'
 *   vsTarget: true          → 'target:is:<the uuid stored in the effect's value>' (never, when none is stored)
 *
 * @param {object} rule a roll rule (data/conditions.js); `tests` may be left out when it has a `when`
 * @param {{targetUuid?: string} | null} [value] the value of the effect that carries the rule, for `vsTarget`
 * @returns {unknown[]} a `when`
 */
export function rulePredicate(rule, value) {
    const own = Array.isArray(rule?.when) ? rule.when : null;
    const out = rule?.tests == null && own ? [] : testsPredicate(rule?.tests);
    if (rule?.beyondSenses) out.push(FACT.BEYOND_SENSES);
    if (rule?.vsTarget) out.push(isId(value?.targetUuid) ? FACT.is('target', value.targetUuid) : NEVER);
    if (own) out.push(...own);
    return out;
}
