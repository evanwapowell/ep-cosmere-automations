/**
 * Predicates for roll rules (#7): the facts of a test, `when`, and the shorthand fields that compile to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONDITIONS, CONDITIONS_BY_ID } from '../data/conditions.js';
import { SITUATIONAL, SITUATIONAL_BY_ID } from '../data/situational.js';
import { FACT, FACT_SHAPES, factsIn, holds, MAX_DEPTH, NEVER, parsePredicate, rollFacts, rulePredicate, testsPredicate, validatePredicate } from '../scripts/logic/predicates.js';
import { collectModifiers, needsSensesRange, ruleError, ruleMatchesTest, ruleProblems, sideConditions, sideSources } from '../scripts/logic/rolls.js';
import { normalizeRules, parseRules, resolveRules, RULES_SCHEMA, validateRules } from '../scripts/logic/rules.js';
import { validateSituational, validateTable } from '../scripts/logic/table.js';

const TABLES = { conditions: CONDITIONS_BY_ID, situational: SITUATIONAL_BY_ID };
const KNOWN = { conditions: CONDITIONS.map((c) => c.id), skills: ['ath', 'prc', 'inm', 'hwp', 'lwp', 'ded'] };
const full = { modeOf: () => 'full' };
const set = (...facts) => new Set(facts);

/* --- The evaluator --- */

test('holds: every term of the list has to hold; no predicate always holds', () => {
    const facts = set('test:attack', 'attack:melee');
    assert.equal(holds(['test:attack'], facts), true);
    assert.equal(holds(['test:attack', 'attack:melee'], facts), true);
    assert.equal(holds(['test:attack', 'attack:ranged'], facts), false);
    assert.equal(holds([], facts), true);
    assert.equal(holds(undefined, facts), true);
    assert.equal(holds(null, facts), true);
    assert.equal(holds(['test:attack'], ['test:attack']), true, 'facts may be any list');
    assert.equal(holds(['test:attack'], undefined), false);
});

test('holds: or, not, and lists inside them', () => {
    const facts = set('test:attack', 'attack:melee', 'target:condition:prone');
    assert.equal(holds([{ or: ['attack:ranged', 'attack:melee'] }], facts), true);
    assert.equal(holds([{ or: ['attack:ranged', 'test:skill:prc'] }], facts), false);
    assert.equal(holds([{ not: 'attack:ranged' }], facts), true);
    assert.equal(holds([{ not: 'attack:melee' }], facts), false);
    assert.equal(holds([{ not: { not: 'attack:melee' } }], facts), true);
    assert.equal(holds(['test:attack', { not: { or: ['target:condition:flying', 'target:condition:prone'] } }], facts), false);
    // A list inside a term means "all of these": ranged, or melee against a Prone target.
    const either = [{ or: ['attack:ranged', ['attack:melee', 'target:condition:prone']] }];
    assert.equal(holds(either, facts), true);
    assert.equal(holds(either, set('test:attack', 'attack:melee')), false);
    assert.equal(holds(either, set('test:attack', 'attack:ranged')), true);
    assert.equal(holds([{ not: ['attack:melee', 'target:condition:flying'] }], facts), true, 'not both');
    assert.equal(holds([NEVER], facts), false, 'an empty "or" never holds');
    assert.equal(holds([{ not: NEVER }], facts), true);
});

test('holds: an unknown fact is false, never an error; neither is anything that is not a term', () => {
    const facts = set('test:attack');
    assert.equal(holds(['weather:rain'], facts), false);
    assert.equal(holds(['test:attack', 'self:condition:no-such-condition'], facts), false);
    assert.equal(holds([{ not: 'weather:rain' }], facts), true, 'so its "not" holds');
    assert.equal(holds([{ or: ['weather:rain', 'test:attack'] }], facts), true);
    assert.equal(holds([''], facts), false);
    for (const junk of [42, null, undefined, true, {}, { and: ['test:attack'] }, { or: 'test:attack' }, () => true, Symbol('x')]) {
        assert.equal(holds([junk], facts), false, `${String(junk)} as a term`);
        assert.equal(holds(['test:attack', { or: [junk] }], facts), false);
    }
    assert.equal(holds(42, facts), false);
    assert.equal(holds('test:attack', facts), true, 'a bare fact is a term');
});

test('holds and the validator stop at the same depth, without throwing', () => {
    const nest = (levels) => {
        let term = 'test:attack';
        for (let i = 0; i < levels; i++) term = { not: { not: term } };
        return term;
    };
    assert.equal(holds([nest(2)], set('test:attack')), true);
    assert.deepEqual(validatePredicate([nest(2)]), []);
    const deep = [nest(MAX_DEPTH)];
    assert.equal(holds(deep, set('test:attack')), false);
    assert.match(validatePredicate(deep).join('\n'), /nested more than 8 deep/);
    const loop = { or: [] };
    loop.or.push(loop);
    assert.equal(holds([loop], set()), false, 'a term that contains itself');
    assert.ok(validatePredicate([loop]).length > 0);
    assert.deepEqual([...factsIn([loop])], []);
});

/* --- The facts of a test --- */

test('rollFacts: the test, then each side', () => {
    const roller = { uuid: 'Actor.kal', conditions: ['restrained', 'slowed'], stance: 'flamestance' };
    const target = { uuid: 'Actor.brute', conditions: ['prone'], stance: null };
    assert.deepEqual([...rollFacts({ roller, target, test: { context: 'Attack', skill: 'hwp', attackType: 'melee' } })].sort(), [
        'attack:melee',
        'self:condition:restrained',
        'self:condition:slowed',
        'self:is:Actor.kal',
        'self:stance:flamestance',
        'target:condition:prone',
        'target:is:Actor.brute',
        'test:attack',
        'test:skill:hwp',
    ]);
    assert.deepEqual([...rollFacts({ roller: { uuid: 'Actor.kal' }, target: null, test: { context: 'Skill', skill: 'prc', attackType: null } })].sort(), [
        'self:is:Actor.kal',
        'test:skill:prc',
    ]);
});

test('rollFacts: what is not known is not there', () => {
    const facts = (test, sides = {}) => [...rollFacts({ ...sides, test })].sort();
    assert.deepEqual(facts({ context: 'Attack', skill: null, attackType: null }), ['test:attack'], 'an attack of unknown kind');
    assert.deepEqual(facts({ context: 'Skill', skill: 'ath', attackType: 'melee' }), ['test:skill:ath'], 'attack:* only on an attack test');
    assert.deepEqual(facts({ context: 'Item', skill: 'ded' }), ['test:skill:ded'], 'an item\'s skill test is not an attack');
    assert.deepEqual(facts({ context: 'Attack', attackType: 'thrown' }), ['test:attack']);
    assert.deepEqual(facts({ context: 'Attack', beyondSenses: true }), ['target:beyond-senses', 'test:attack']);
    assert.deepEqual(facts({ context: 'Attack', beyondSenses: null }), ['test:attack'], 'not measured');
    assert.deepEqual(facts({ context: 'Attack', beyondSenses: false }), ['test:attack']);
    assert.deepEqual(facts({ context: 'Skill' }, { roller: {}, target: { conditions: [null, '', 'prone'] } }), ['target:condition:prone']);
    assert.deepEqual(facts(null), []);
    assert.deepEqual([...rollFacts()], []);
});

test('every fact rollFacts gives has a shape the validator knows', () => {
    const roller = { uuid: 'Scene.s.Token.t.Actor.a', conditions: CONDITIONS.map((c) => c.id), stance: 'stone-stance' };
    const facts = rollFacts({ roller, target: roller, test: { context: 'Attack', skill: 'hwp', attackType: 'ranged', beyondSenses: true } });
    assert.deepEqual(validatePredicate([...facts], KNOWN), []);
    assert.deepEqual(validatePredicate([...rollFacts({ test: { context: 'Attack', attackType: 'melee' } })]), []);
    // Each documented shape is one of them, with its placeholder filled in.
    const fill = (shape) => shape.replace('<skill id>', 'prc').replace('<condition id>', 'prone').replace('<stance id>', 'flamestance').replace('<actor uuid>', 'Actor.x');
    assert.deepEqual(validatePredicate(FACT_SHAPES.map(fill), KNOWN), []);
    assert.equal(FACT_SHAPES.length, 11);
});

test('sideConditions: every table condition among the rows, once', () => {
    const rows = [
        { effect: { id: 'a' }, conditionId: 'prone' },
        { effect: { id: 'b' }, conditionId: 'prone' },
        { effect: { id: 'c' }, conditionId: 'surprised' },
        { effect: { id: 'd' }, situationalId: 'dodging', conditionId: null },
    ];
    assert.deepEqual(sideConditions(rows), ['prone', 'surprised']);
    assert.deepEqual(sideConditions(null), []);
});

/* --- The validator --- */

test('validatePredicate: a list of facts, or and not', () => {
    assert.deepEqual(validatePredicate([]), []);
    assert.deepEqual(validatePredicate(['test:attack', { or: ['attack:melee', ['attack:ranged', { not: 'target:beyond-senses' }]] }, { not: 'self:condition:prone' }], KNOWN), []);
    assert.deepEqual(validatePredicate(['self:stance:stone-stance', 'target:is:Scene.s.Token.t.Actor.a', 'self:is:Actor.b', 'target:stance:windstance']), []);
});

test('validatePredicate: problems say where', () => {
    const shapes = /when: must be a list of terms/;
    for (const notList of ['test:attack', { or: ['test:attack'] }, 7, true]) assert.match(validatePredicate(notList).join('\n'), shapes);
    const problems = validatePredicate(
        [
            'target:prone',
            'test:skill:stealthy',
            { or: ['self:condition:pinned', { not: 'attack:thrown' }] },
            { or: [] },
            { or: 'test:attack' },
            { not: ['test:attack', 5] },
            { and: ['test:attack'] },
            { or: ['test:attack'], not: 'attack:melee' },
            [],
            'test:skill:',
            ' test:attack',
            'Test:Attack',
            'self:is:',
            'target:beyond-senses:far',
            'self:beyond-senses',
            null,
            { not: undefined },
        ],
        KNOWN,
    );
    const expected = [
        'when[0]: unknown fact "target:prone" (known: test:attack, test:skill:<skill id>, attack:melee, attack:ranged, ',
        'when[1]: unknown skill "stealthy" in "test:skill:stealthy"',
        'when[2].or[0]: unknown condition "pinned" in "self:condition:pinned"',
        'when[2].or[1].not: unknown fact "attack:thrown"',
        'when[3].or: an empty "or" never holds',
        'when[4].or: must be a list of terms',
        'when[5].not[1]: 5 is not a term',
        'when[6]: {"and":["test:attack"]} is not a term',
        'when[7]: {"or":["test:attack"],"not":"attack:melee"} is not a term',
        'when[8]: an empty list always holds; leave it out',
        'when[9]: unknown fact "test:skill:"',
        'when[10]: unknown fact " test:attack"',
        'when[11]: unknown fact "Test:Attack"',
        'when[12]: unknown fact "self:is:"',
        'when[13]: unknown fact "target:beyond-senses:far"',
        'when[14]: unknown fact "self:beyond-senses"',
        'when[15]: null is not a term',
        'when[16].not: undefined is not a term',
    ];
    assert.equal(problems.length, expected.length, problems.join('\n'));
    expected.forEach((fragment, i) => assert.ok(problems[i].startsWith(fragment), `expected "${fragment}", got "${problems[i]}"`));
});

test('validatePredicate: condition and skill ids are only checked when the valid ones are given', () => {
    const when = ['test:skill:stealthy', 'target:condition:pinned'];
    assert.deepEqual(validatePredicate(when), []);
    assert.deepEqual(validatePredicate(when, { skills: null, conditions: undefined }), []);
    assert.equal(validatePredicate(when, { skills: new Set(['prc']) }).length, 1);
    assert.equal(validatePredicate(when, KNOWN).length, 2);
});

test('parsePredicate: a clean copy that shares nothing with what was given', () => {
    const given = ['test:attack', { or: ['attack:melee', ['attack:ranged', { not: 'target:beyond-senses' }]] }];
    const { when, problems } = parsePredicate(given);
    assert.deepEqual(problems, []);
    assert.deepEqual(when, given);
    when[1].or[1].push('test:skill:lwp');
    assert.equal(given[1].or[1].length, 2);
    assert.equal(parsePredicate(['nope']).when, null);
});

test('factsIn: every fact a predicate names, however deep', () => {
    const when = ['test:attack', { or: ['attack:melee', ['attack:ranged', { not: 'target:beyond-senses' }]] }];
    assert.deepEqual([...factsIn(when)].sort(), ['attack:melee', 'attack:ranged', 'target:beyond-senses', 'test:attack']);
    assert.deepEqual([...factsIn(undefined)], []);
    assert.deepEqual([...factsIn([7, null, { and: ['x'] }])], []);
});

/* --- Shorthand: today's fields compile to `when` --- */

test('the shorthand fields compile to the documented predicates', () => {
    assert.deepEqual(testsPredicate('all'), []);
    assert.deepEqual(testsPredicate('attack'), ['test:attack']);
    assert.deepEqual(testsPredicate('melee'), ['test:attack', 'attack:melee']);
    assert.deepEqual(testsPredicate('ranged'), ['test:attack', 'attack:ranged']);
    assert.deepEqual(testsPredicate({ skills: ['prc'] }), ['test:skill:prc']);
    assert.deepEqual(testsPredicate({ skills: ['prc', 'inm'] }), [{ or: ['test:skill:prc', 'test:skill:inm'] }]);
    for (const unknown of [undefined, null, 'thrown', { skills: [] }, {}]) assert.deepEqual(testsPredicate(unknown), [NEVER]);

    assert.deepEqual(rulePredicate({ who: 'self', mode: 'disadvantage', tests: 'attack', beyondSenses: true }), ['test:attack', 'target:beyond-senses']);
    assert.deepEqual(rulePredicate({ who: 'self', mode: 'advantage', tests: 'all', vsTarget: true }, { targetUuid: 'Actor.t' }), ['target:is:Actor.t']);
    assert.deepEqual(rulePredicate({ who: 'self', mode: 'advantage', tests: 'all', vsTarget: true }, null), [NEVER], 'no stored target: never');
    assert.deepEqual(rulePredicate({ who: 'target', mode: 'disadvantage', tests: 'attack', consume: true }), ['test:attack'], 'consume is not a condition');
    assert.deepEqual(
        rulePredicate({ who: 'self', mode: 'advantage', tests: 'melee', beyondSenses: true, vsTarget: true, when: [{ not: 'self:condition:prone' }] }, { targetUuid: 'Actor.t' }),
        ['test:attack', 'attack:melee', 'target:beyond-senses', 'target:is:Actor.t', { not: 'self:condition:prone' }],
        'shorthand first, then the rule\'s own when: all of it has to hold',
    );
    assert.deepEqual(rulePredicate({ who: 'self', mode: 'advantage', when: ['test:attack'] }), ['test:attack'], 'no tests: every test');
    assert.deepEqual(rulePredicate({ who: 'self', mode: 'advantage' }), [NEVER], 'neither tests nor when: not a rule');
    const rule = { who: 'self', mode: 'advantage', tests: 'attack', when: ['attack:melee'] };
    rulePredicate(rule).push('x');
    assert.deepEqual(rule.when, ['attack:melee'], 'the rule is not changed');
});

/** How the roll layer matched `tests` and `beyondSenses` before predicates (scripts/logic/rolls.js up to #5). */
function legacyMatchesTest(rule, test) {
    if (rule.beyondSenses && test.beyondSenses !== true) return false;
    const tests = rule.tests;
    const isAttack = test.context === 'Attack';
    if (tests === 'all') return true;
    if (tests === 'attack') return isAttack;
    if (tests === 'melee' || tests === 'ranged') return isAttack && test.attackType === tests;
    if (tests && Array.isArray(tests.skills)) return !!test.skill && tests.skills.includes(test.skill);
    return false;
}
/** …and `vsTarget`, as `collectModifiers` checked it. */
const legacyApplies = (rule, test, value, target) => legacyMatchesTest(rule, test) && !(rule.vsTarget && (!target || value?.targetUuid !== target.uuid));

const SHORTHANDS = [
    { tests: 'all' },
    { tests: 'attack' },
    { tests: 'melee' },
    { tests: 'ranged' },
    { tests: { skills: ['prc'] } },
    { tests: { skills: ['prc', 'hwp'] } },
    { tests: 'attack', beyondSenses: true },
    { tests: 'all', beyondSenses: true },
    { tests: 'all', vsTarget: true },
    { tests: 'melee', vsTarget: true },
    { tests: { skills: ['ded', 'lwp'] }, vsTarget: true, beyondSenses: true },
];
const MATRIX = [];
for (const context of ['Skill', 'Item', 'Attack']) {
    for (const skill of [null, 'prc', 'hwp', 'lwp', 'ded']) {
        for (const attackType of [null, 'melee', 'ranged']) {
            for (const beyond of [undefined, null, false, true]) MATRIX.push({ context, skill, attackType, beyondSenses: beyond });
        }
    }
}
const VALUES = [null, {}, { targetUuid: 'Actor.t', targetName: 'Brute' }, { targetUuid: 'Actor.other' }];
const TARGETS = [null, { uuid: 'Actor.t', name: 'Brute', sources: [] }];
const sideWith = (rule, value) => ({ uuid: 'Actor.a', name: 'A', sources: [{ key: 'E', modeKey: 'effect:E', label: 'E', rules: { schema: 1, rolls: [rule] }, value, effectId: 'E' }] });

test('each shorthand and its compiled form agree on a matrix of tests (and with how it was matched before)', () => {
    let applied = 0;
    for (const shorthand of SHORTHANDS) {
        for (const value of VALUES) {
            const rule = { who: 'self', mode: 'advantage', ...shorthand };
            // The same rule written with `when` alone: no shorthand field left.
            const compiled = { who: 'self', mode: 'advantage', when: rulePredicate(rule, value) };
            assert.deepEqual(ruleProblems(rule), []);
            for (const target of TARGETS) {
                for (const test of MATRIX) {
                    const expected = legacyApplies(rule, test, value, target);
                    const where = `${JSON.stringify(shorthand)} value ${JSON.stringify(value)} target ${target?.uuid} on ${JSON.stringify(test)}`;
                    const got = (r) => collectModifiers({ roller: sideWith(r, value), target, test }, full).length === 1;
                    assert.equal(got(rule), expected, `shorthand: ${where}`);
                    assert.equal(got(compiled), expected, `compiled ${JSON.stringify(compiled.when)}: ${where}`);
                    if (!shorthand.vsTarget) assert.equal(ruleMatchesTest(rule, test), expected, `ruleMatchesTest: ${where}`);
                    if (expected) applied++;
                }
            }
        }
    }
    assert.ok(applied > 500, `the matrix has both outcomes (${applied} applied)`);
});

test('the same holds for rules the target carries', () => {
    for (const shorthand of SHORTHANDS.filter((s) => !s.vsTarget && !s.beyondSenses)) {
        const rule = { who: 'target', mode: 'disadvantage', ...shorthand };
        const compiled = { who: 'target', mode: 'disadvantage', when: rulePredicate(rule) };
        for (const test of MATRIX) {
            const got = (r) => collectModifiers({ roller: { uuid: 'Actor.a', name: 'A', sources: [] }, target: { ...sideWith(r, null), uuid: 'Actor.t' }, test }, full).length === 1;
            assert.equal(got(rule), legacyMatchesTest(rule, test));
            assert.equal(got(compiled), legacyMatchesTest(rule, test));
        }
    }
});

test('every roll rule of both tables compiles to a valid `when`, and the tables still validate', () => {
    assert.deepEqual(validateTable(CONDITIONS), []);
    assert.deepEqual(validateSituational(SITUATIONAL, new Set(CONDITIONS.map((c) => c.id))), []);
    const compiled = {};
    for (const entry of [...CONDITIONS, ...SITUATIONAL]) {
        for (const rule of entry.rolls ?? []) {
            const when = rulePredicate(rule, { targetUuid: 'Actor.t' });
            assert.deepEqual(validatePredicate(when, KNOWN), [], entry.id);
            compiled[entry.id] = when;
        }
    }
    assert.deepEqual(compiled, {
        blind: ['test:attack', 'target:beyond-senses'],
        disoriented: ['test:skill:prc'],
        empowered: [],
        flying: ['test:attack', 'attack:ranged'],
        hidden: ['test:attack'],
        invisible: ['test:attack'],
        prone: ['test:attack', 'attack:melee'],
        restrained: [],
        dodging: ['test:attack'],
        bracing: ['test:attack'],
        advantage: ['target:is:Actor.t'],
        flamestance: ['test:skill:inm'],
    });
});

/* --- `when` on a roll rule --- */

const withConditions = (rolls, { conditions = [], stance = null, value = null, uuid = 'Actor.a' } = {}) => {
    const rows = [
        { effect: { id: 'E', name: 'Effect' }, rules: { schema: 1, rolls }, value },
        ...conditions.map((id, i) => ({ effect: { id: `c${i}`, name: id }, rules: { schema: 1 }, conditionId: id })),
    ];
    return { uuid, name: 'A', sources: sideSources(rows, { stance, ...TABLES }), conditions: sideConditions(rows), stance };
};
const bare = (uuid, extra = {}) => ({ uuid, name: uuid, sources: [], ...extra });
const melee = { context: 'Attack', skill: 'hwp', attackType: 'melee' };
const ranged = { context: 'Attack', skill: 'lwp', attackType: 'ranged' };
const count = (situation) => collectModifiers(situation, full).length;

test('a rule with a `when`: advantage on attacks against a Stunned or Surprised target', () => {
    const rule = { who: 'self', mode: 'advantage', when: ['test:attack', { or: ['target:condition:stunned', 'target:condition:surprised'] }] };
    assert.equal(ruleError(rule, KNOWN), null);
    const roller = withConditions([rule]);
    assert.equal(count({ roller, target: bare('Actor.t', { conditions: ['surprised'] }), test: melee }), 1);
    assert.equal(count({ roller, target: bare('Actor.t', { conditions: ['prone', 'stunned'] }), test: ranged }), 1);
    assert.equal(count({ roller, target: bare('Actor.t', { conditions: ['prone'] }), test: melee }), 0);
    assert.equal(count({ roller, target: bare('Actor.t', { conditions: ['stunned'] }), test: { context: 'Skill', skill: 'ath' } }), 0, 'not an attack');
    assert.equal(count({ roller, target: null, test: melee }), 0, 'no target: nothing is known about it');
});

test('`when` narrows the shorthand: both have to hold', () => {
    const rule = { who: 'target', mode: 'advantage', tests: 'melee', when: [{ not: 'self:condition:prone' }] };
    const target = { ...withConditions([rule]), uuid: 'Actor.t' };
    assert.equal(count({ roller: bare('Actor.a', { conditions: [] }), target, test: melee }), 1);
    assert.equal(count({ roller: bare('Actor.a', { conditions: ['prone'] }), target, test: melee }), 0, 'self is the roller, not the one with the rule');
    assert.equal(count({ roller: bare('Actor.a'), target, test: ranged }), 0, 'tests: melee still counts');
});

test('facts about stances and about who the two sides are', () => {
    const unlessStone = { who: 'self', mode: 'disadvantage', when: [{ or: ['test:skill:ath', 'test:skill:prc'] }, { not: 'self:stance:stonestance' }] };
    const test = { context: 'Skill', skill: 'ath' };
    assert.equal(count({ roller: withConditions([unlessStone]), target: null, test }), 1);
    assert.equal(count({ roller: withConditions([unlessStone], { stance: 'stonestance' }), target: null, test }), 0);
    assert.equal(count({ roller: withConditions([unlessStone], { stance: 'windstance' }), target: null, test }), 1);
    assert.equal(count({ roller: withConditions([unlessStone]), target: null, test: { context: 'Skill', skill: 'inm' } }), 0);

    // On the target: only that one enemy's attacks are hindered.
    const marked = { who: 'target', mode: 'disadvantage', tests: 'attack', when: ['self:is:Actor.brute'] };
    const target = { ...withConditions([marked]), uuid: 'Actor.t' };
    assert.equal(count({ roller: bare('Actor.brute'), target, test: melee }), 1);
    assert.equal(count({ roller: bare('Actor.other'), target, test: melee }), 0);
    const versus = { who: 'self', mode: 'advantage', when: ['target:is:Actor.t', 'target:stance:flamestance'] };
    assert.equal(count({ roller: withConditions([versus]), target: bare('Actor.t', { stance: 'flamestance' }), test: melee }), 1);
    assert.equal(count({ roller: withConditions([versus]), target: bare('Actor.t'), test: melee }), 0);
});

test('`when` goes with vsTarget and consume: the stored target, and used up only when it applied', () => {
    const rule = { who: 'self', mode: 'advantage', tests: 'all', vsTarget: true, consume: true, when: [{ not: 'test:skill:ded' }] };
    const roller = withConditions([rule], { value: { targetUuid: 'Actor.t', targetName: 'Brute' } });
    const brute = bare('Actor.t');
    const mods = collectModifiers({ roller, target: brute, test: melee }, full);
    assert.deepEqual(mods.map((m) => [m.label, m.consume?.effectId]), [['Effect (Brute)', 'E']]);
    assert.deepEqual(collectModifiers({ roller, target: brute, test: { context: 'Skill', skill: 'ded' } }, full), [], 'not with that skill: kept for later');
    assert.deepEqual(collectModifiers({ roller, target: bare('Actor.o'), test: melee }, full), []);
});

test('needsSensesRange: the shorthand, or a `when` that names the fact, on the side whose rules count', () => {
    const blind = withConditions([{ who: 'self', mode: 'disadvantage', tests: 'attack', beyondSenses: true }]);
    const written = withConditions([{ who: 'self', mode: 'disadvantage', when: ['test:attack', { or: ['attack:melee', { not: 'target:beyond-senses' }] }] }]);
    const plain = withConditions([{ who: 'self', mode: 'disadvantage', tests: 'attack' }]);
    const camouflaged = withConditions([{ who: 'target', mode: 'disadvantage', tests: 'attack', when: ['target:beyond-senses'] }]);
    assert.equal(needsSensesRange(blind), true);
    assert.equal(needsSensesRange(written), true);
    assert.equal(needsSensesRange(plain), false);
    assert.equal(needsSensesRange(null), false);
    assert.equal(needsSensesRange(camouflaged), false, 'as the roller, its "target" rules don\'t apply');
    assert.equal(needsSensesRange(camouflaged, 'target'), true);
    assert.equal(needsSensesRange(blind, 'target'), false);
    assert.equal(count({ roller: bare('Actor.a'), target: { ...camouflaged, uuid: 'Actor.t' }, test: { ...ranged, beyondSenses: true } }), 1);
    assert.equal(count({ roller: bare('Actor.a'), target: { ...camouflaged, uuid: 'Actor.t' }, test: { ...ranged, beyondSenses: null } }), 0);
});

/* --- `when` in an effect's rules (schema 1) --- */

test('rules: `when` is one more optional field of a roll rule; the schema stays 1', () => {
    assert.equal(RULES_SCHEMA, 1);
    const rules = {
        rolls: [
            { who: 'self', mode: 'advantage', when: ['test:attack', { or: ['target:condition:stunned', 'target:condition:surprised'] }] },
            { who: 'target', mode: 'disadvantage', tests: 'ranged', when: [{ not: 'self:condition:empowered' }], consume: true },
            { who: 'self', mode: 'advantage', tests: 'all', when: [] },
        ],
    };
    assert.deepEqual(validateRules(rules, KNOWN), []);
    const clean = normalizeRules(rules);
    assert.deepEqual(clean, {
        schema: 1,
        rolls: [
            { who: 'self', mode: 'advantage', tests: 'all', when: ['test:attack', { or: ['target:condition:stunned', 'target:condition:surprised'] }] },
            { who: 'target', mode: 'disadvantage', tests: 'ranged', consume: true, when: [{ not: 'self:condition:empowered' }] },
            { who: 'self', mode: 'advantage', tests: 'all' },
        ],
    });
    assert.deepEqual(normalizeRules(clean), clean, 'normalizing twice changes nothing');
    clean.rolls[0].when[1].or.push('x');
    assert.equal(rules.rolls[0].when[1].or.length, 2, 'nothing shared with what was given');
    // Rules written before `when` existed read exactly as they did.
    const before = { schema: 1, rolls: [{ who: 'self', mode: 'disadvantage', tests: 'attack', beyondSenses: true }] };
    assert.deepEqual(normalizeRules(before), before);
});

test('rules: a bad `when` is reported at its place, and the effect then falls back to its defaults', () => {
    const rules = {
        rolls: [
            { who: 'self', mode: 'advantage', tests: 'all', when: ['target:prone', { or: [] }] },
            { who: 'self', mode: 'advantage', when: 'test:attack' },
            { who: 'self', mode: 'advantage', when: ['test:skill:stealthy', 'self:condition:pinned'] },
            { who: 'self', mode: 'advantage', when: null },
            { who: 'self', mode: 'advantage', tests: 'thrown', when: ['nope'] },
        ],
    };
    const { ok, problems } = parseRules(rules, KNOWN);
    assert.equal(ok, false);
    const expected = [
        'rolls[0]: when[0]: unknown fact "target:prone"',
        'rolls[0]: when[1].or: an empty "or" never holds',
        'rolls[1]: when: must be a list of terms',
        'rolls[2]: when[0]: unknown skill "stealthy"',
        'rolls[2]: when[1]: unknown condition "pinned"',
        'rolls[3]: unknown tests undefined',
        'rolls[4]: unknown tests "thrown"',
    ];
    assert.equal(problems.length, expected.length, problems.join('\n'));
    expected.forEach((fragment, i) => assert.ok(problems[i].startsWith(fragment), `expected "${fragment}", got "${problems[i]}"`));
    const resolved = resolveRules({ rolls: [rules.rolls[0]] }, CONDITIONS_BY_ID.prone, KNOWN);
    assert.deepEqual(resolved.rules.rolls, [{ who: 'target', mode: 'advantage', tests: 'melee' }], 'the table\'s Prone');
    assert.equal(resolved.problems.length, 2);
});

test('a table entry may use `when` too', () => {
    const entry = { id: 'x', name: 'X', summary: 's', mechanics: [], links: [], rolls: [{ who: 'target', mode: 'advantage', tests: 'melee', when: [{ not: 'self:condition:prone' }] }] };
    assert.deepEqual(validateTable([entry]), []);
    assert.match(validateTable([{ ...entry, rolls: [{ who: 'target', mode: 'advantage', when: ['self:prone'] }] }]).join('\n'), /x: roll rule: when\[0\]: unknown fact "self:prone"/);
    assert.equal(FACT.condition('self', 'prone'), 'self:condition:prone');
});
