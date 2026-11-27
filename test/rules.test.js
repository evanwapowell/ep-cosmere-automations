import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONDITIONS, CONDITIONS_BY_ID, MECHANICS } from '../data/conditions.js';
import { SITUATIONAL, SITUATIONAL_BY_ID } from '../data/situational.js';
import { FLAGS } from '../scripts/constants.js';
import {
    ENDS_WHEN,
    entryToRules,
    hasRules,
    MECHANIC_KINDS,
    MECHANIC_RECORDS,
    normalizeRules,
    parseRules,
    RULE_FIELDS,
    RULES_SCHEMA,
    validateRules,
} from '../scripts/logic/rules.js';

const CONDITION_IDS = CONDITIONS.map((c) => c.id);
const known = { conditions: CONDITION_IDS, skills: ['ath', 'prc', 'inm'], attributes: ['str', 'spd'] };

/** Assert that each fragment appears in some problem. */
function assertProblems(problems, fragments) {
    const joined = problems.join('\n');
    for (const fragment of fragments) assert.ok(joined.includes(fragment), `expected "${fragment}" in:\n${joined}`);
}

test('the rules flag has a name', () => {
    assert.equal(FLAGS.RULES, 'rules');
});

// --- The tables as rules ---------------------------------------------------------------------------------------

test('every entry of the condition table converts to valid rules', () => {
    for (const entry of CONDITIONS) {
        const rules = entryToRules(entry);
        assert.equal(rules.schema, 1, entry.id);
        assert.deepEqual(validateRules(rules, known), [], entry.id);
        assert.deepEqual(normalizeRules(rules), rules, `${entry.id}: already normalized`);
    }
});

test('every entry of the situational table converts to valid rules', () => {
    for (const entry of SITUATIONAL) {
        const rules = entryToRules(entry);
        assert.deepEqual(validateRules(rules, known), [], entry.id);
        assert.deepEqual(normalizeRules(rules), rules, `${entry.id}: already normalized`);
        assert.ok(hasRules(rules), `${entry.id} has rules`);
    }
});

test('the four mechanic names each have a record, and the records are valid', () => {
    assert.deepEqual(Object.keys(MECHANIC_RECORDS).sort(), Object.values(MECHANICS).sort());
    assert.deepEqual(validateRules({ mechanics: Object.values(MECHANIC_RECORDS) }), []);
    assert.deepEqual(MECHANIC_RECORDS[MECHANICS.NO_MOVEMENT], { kind: 'movement', op: 'zero' });
    assert.deepEqual(MECHANIC_RECORDS[MECHANICS.HALF_MOVEMENT], { kind: 'movement', op: 'half' });
    assert.deepEqual(MECHANIC_RECORDS[MECHANICS.SKILL_PENALTY_PER_STACK], { kind: 'skillModifier', amount: -1, perStack: true, skills: 'all' });
    assert.deepEqual(MECHANIC_RECORDS[MECHANICS.ATTRIBUTE_BONUS], { kind: 'attributeBonus', from: 'value' });
});

test('conditions convert to what the table says', () => {
    const rules = (id) => entryToRules(CONDITIONS_BY_ID[id]);
    assert.deepEqual(rules('exhausted'), {
        schema: 1,
        mechanics: [{ kind: 'skillModifier', amount: -1, perStack: true, skills: 'all' }],
        longRest: 1,
    });
    assert.deepEqual(rules('slowed'), { schema: 1, mechanics: [{ kind: 'movement', op: 'half' }] });
    assert.deepEqual(rules('immobilized'), { schema: 1, mechanics: [{ kind: 'movement', op: 'zero' }] });
    assert.deepEqual(rules('restrained'), {
        schema: 1,
        mechanics: [{ kind: 'movement', op: 'zero' }],
        rolls: [{ who: 'self', mode: 'disadvantage', tests: 'all' }],
    });
    assert.deepEqual(rules('enhanced'), { schema: 1, mechanics: [{ kind: 'attributeBonus', from: 'value' }] });
    assert.deepEqual(rules('prone'), { schema: 1, links: ['slowed'], rolls: [{ who: 'target', mode: 'advantage', tests: 'melee' }] });
    assert.deepEqual(rules('unconscious'), { schema: 1, mechanics: [{ kind: 'movement', op: 'zero' }], links: ['prone'] });
    assert.deepEqual(rules('disoriented'), { schema: 1, rolls: [{ who: 'self', mode: 'disadvantage', tests: { skills: ['prc'] } }] });
    assert.deepEqual(rules('blind'), { schema: 1, rolls: [{ who: 'self', mode: 'disadvantage', tests: 'attack', beyondSenses: true }] });
    assert.deepEqual(rules('surprised'), { schema: 1, duration: ['endOfNextTurn'] });
    assert.deepEqual(rules('empowered'), { schema: 1, rolls: [{ who: 'self', mode: 'advantage', tests: 'all' }], duration: ['endOfScene'] });
});

test('a condition with nothing to automate converts to empty rules', () => {
    for (const id of ['dead', 'burrowing', 'afflicted', 'stunned']) {
        assert.deepEqual(entryToRules(CONDITIONS_BY_ID[id]), { schema: 1 }, id);
        assert.equal(hasRules(entryToRules(CONDITIONS_BY_ID[id])), false, id);
    }
    assert.deepEqual(entryToRules(undefined), { schema: 1 }, 'no entry: no defaults');
});

test('situational effects convert to what the table says', () => {
    const rules = (id) => entryToRules(SITUATIONAL_BY_ID[id]);
    assert.deepEqual(rules('dodging'), {
        schema: 1,
        rolls: [{ who: 'target', mode: 'disadvantage', tests: 'attack', consume: true }],
        duration: ['untilUsed', 'endOfCurrentTurn'],
    });
    assert.deepEqual(rules('bracing'), {
        schema: 1,
        rolls: [{ who: 'target', mode: 'disadvantage', tests: 'attack' }],
        duration: ['endOfScene'],
        endsWhen: ['attack', 'move'],
    });
    assert.deepEqual(rules('advantage'), {
        schema: 1,
        rolls: [{ who: 'self', mode: 'advantage', tests: 'all', vsTarget: true, consume: true }],
        duration: ['untilUsed', 'endOfScene'],
    });
    assert.deepEqual(rules('flamestance'), { schema: 1, rolls: [{ who: 'self', mode: 'advantage', tests: { skills: ['inm'] } }] });
});

test('converted rules share nothing with the table', () => {
    const rules = entryToRules(CONDITIONS_BY_ID.disoriented);
    rules.rolls[0].tests.skills.push('ath');
    rules.rolls.push({ who: 'self', mode: 'advantage', tests: 'all' });
    assert.deepEqual(CONDITIONS_BY_ID.disoriented.rolls, [{ who: 'self', mode: 'disadvantage', tests: { skills: ['prc'] } }]);

    const exhausted = entryToRules(CONDITIONS_BY_ID.exhausted);
    exhausted.mechanics[0].amount = -5;
    assert.equal(MECHANIC_RECORDS[MECHANICS.SKILL_PENALTY_PER_STACK].amount, -1);
    assert.equal(entryToRules(CONDITIONS_BY_ID.exhausted).mechanics[0].amount, -1);
});

test('a broken table entry does not convert quietly', () => {
    assert.throws(() => entryToRules({ id: 'x', mechanics: ['teleport'] }), /x: no rule record for mechanic "teleport"/);
    assert.throws(() => entryToRules({ id: 'y', rolls: [{ who: 'them', mode: 'advantage', tests: 'all' }] }), /y: rolls\[0\]: unknown "who"/);
    assert.throws(() => entryToRules({ id: 'z', duration: ['soon'] }), /z: duration: unknown duration kind/);
});

// --- Valid shapes ----------------------------------------------------------------------------------------------

test('every field is optional', () => {
    assert.deepEqual(validateRules({}), []);
    assert.deepEqual(normalizeRules({}), { schema: 1 });
    assert.deepEqual(validateRules({ schema: 1 }), []);
    for (const field of RULE_FIELDS) assert.deepEqual(validateRules({ [field]: null }), [], `${field}: null is "not set"`);
    assert.deepEqual(normalizeRules({ schema: null, mechanics: null, rolls: undefined, links: null, longRest: null, endsWhen: null, duration: null }), {
        schema: 1,
    });
});

test('no rules at all is valid and normalizes to null', () => {
    for (const none of [undefined, null]) {
        assert.deepEqual(validateRules(none), []);
        assert.equal(normalizeRules(none), null);
        assert.deepEqual(parseRules(none), { ok: true, rules: null, problems: [] });
    }
});

test('"none of this kind" is an empty list (0 for longRest) and survives normalizing', () => {
    const none = { schema: 1, mechanics: [], rolls: [], links: [], longRest: 0, endsWhen: [], duration: [] };
    assert.deepEqual(validateRules(none, known), []);
    assert.deepEqual(normalizeRules(none), none);
    assert.equal(hasRules(normalizeRules(none)), false);
    // Not set is something else: the field is absent, so the table's default applies.
    assert.equal('links' in normalizeRules({ mechanics: [] }), false);
    assert.equal('mechanics' in normalizeRules({ mechanics: [] }), true);
});

test('a full example is valid; normalizing fills in defaults and drops repeats', () => {
    const rules = {
        mechanics: [
            { kind: 'movement', op: 'half' },
            { kind: 'skillModifier', amount: -2 },
            { kind: 'skillModifier', amount: 1, perStack: false, skills: ['prc', 'ath', 'prc'] },
            { kind: 'attributeBonus', attribute: 'str', amount: 1 },
            { kind: 'attributeBonus', from: 'value' },
        ],
        rolls: [
            { who: 'self', mode: 'disadvantage', tests: 'ranged', consume: false },
            { who: 'self', mode: 'advantage', tests: { skills: ['inm', 'inm'] }, vsTarget: true, consume: true },
        ],
        links: ['slowed', 'prone', 'slowed'],
        longRest: 2,
        endsWhen: ['move', 'move'],
        duration: 'endOfScene',
    };
    assert.deepEqual(validateRules(rules, known), []);
    const clean = normalizeRules(rules);
    assert.deepEqual(clean, {
        schema: 1,
        mechanics: [
            { kind: 'movement', op: 'half' },
            { kind: 'skillModifier', amount: -2, perStack: false, skills: 'all' },
            { kind: 'skillModifier', amount: 1, perStack: false, skills: ['prc', 'ath'] },
            { kind: 'attributeBonus', attribute: 'str', amount: 1 },
            { kind: 'attributeBonus', from: 'value' },
        ],
        rolls: [
            { who: 'self', mode: 'disadvantage', tests: 'ranged' },
            { who: 'self', mode: 'advantage', tests: { skills: ['inm'] }, vsTarget: true, consume: true },
        ],
        links: ['slowed', 'prone'],
        longRest: 2,
        endsWhen: ['move'],
        duration: ['endOfScene'],
    });
    assert.ok(hasRules(clean));
    assert.deepEqual(normalizeRules(clean), clean, 'normalizing twice changes nothing');
    assert.deepEqual(validateRules(clean, known), [], 'normalized rules are valid rules');

    // A clean copy: nothing shared with the input.
    clean.mechanics[2].skills.push('inm');
    clean.rolls[1].tests.skills.push('ath');
    clean.links.push('dead');
    assert.deepEqual(rules.mechanics[2].skills, ['prc', 'ath', 'prc']);
    assert.deepEqual(rules.rolls[1].tests.skills, ['inm', 'inm']);
    assert.deepEqual(rules.links, ['slowed', 'prone', 'slowed']);
});

test('duration takes what the API takes; days keep their number', () => {
    const duration = (spec) => normalizeRules({ duration: spec })?.duration;
    assert.deepEqual(duration('untilUsed'), ['untilUsed']);
    assert.deepEqual(duration(['untilUsed', 'endOfScene', 'untilUsed']), ['untilUsed', 'endOfScene']);
    assert.deepEqual(duration({ kinds: 'longRest' }), ['longRest']);
    assert.deepEqual(duration({ kinds: ['days', 'longRest'], days: 3 }), { kinds: ['days', 'longRest'], days: 3 });
    assert.deepEqual(duration('none'), [], 'explicitly no default duration');
    assert.deepEqual(duration('untilRemoved'), []);
    assert.deepEqual(normalizeRules({ duration: { kinds: ['days'], days: 3 } }), { schema: 1, duration: { kinds: ['days'], days: 3 } });
    assert.ok(hasRules({ schema: 1, duration: { kinds: ['days'], days: 3 } }));
    assert.ok(hasRules({ schema: 1, duration: ['endOfScene'] }));
    assert.equal(hasRules({ schema: 1, duration: [] }), false);
});

test('consume and vsTarget are allowed on any effect', () => {
    // The condition table refuses them (validateTable); rules on an effect may have them.
    assert.deepEqual(validateRules({ rolls: [{ who: 'self', mode: 'advantage', tests: 'all', vsTarget: true, consume: true }] }), []);
    assert.deepEqual(validateRules({ rolls: [{ who: 'target', mode: 'disadvantage', tests: 'attack', consume: true }] }), []);
});

test('hasRules: any non-empty field counts', () => {
    assert.equal(hasRules(null), false);
    assert.equal(hasRules(undefined), false);
    assert.equal(hasRules({ schema: 1 }), false);
    assert.equal(hasRules({ schema: 1, longRest: 0 }), false);
    assert.equal(hasRules({ schema: 1, longRest: 1 }), true);
    assert.equal(hasRules({ schema: 1, links: ['slowed'] }), true);
    assert.equal(hasRules({ schema: 1, endsWhen: ['move'] }), true);
    assert.equal(hasRules({ schema: 1, mechanics: [{ kind: 'movement', op: 'zero' }] }), true);
    assert.equal(hasRules({ schema: 1, rolls: [{ who: 'self', mode: 'advantage', tests: 'all' }] }), true);
});

// --- Invalid shapes --------------------------------------------------------------------------------------------

test('unknown schema values are rejected with a clear message', () => {
    assert.deepEqual(validateRules({ schema: 2, mechanics: [] }), [
        'schema: unsupported value 2 (this version of the module reads schema 1; these rules were written for a newer version)',
    ]);
    for (const schema of [0, -1, 1.5, '1', 'v1', true, [1], {}]) {
        const problems = validateRules({ schema });
        assert.equal(problems.length, 1, JSON.stringify(schema));
        assert.ok(problems[0].startsWith(`schema: unsupported value ${JSON.stringify(schema)} (this version of the module reads schema 1`), problems[0]);
        assert.equal(normalizeRules({ schema }), null);
    }
    // The rest of an unknown schema is not judged by this one's rules.
    assert.equal(validateRules({ schema: 2, mechanics: 'whatever', futureField: 1 }).length, 1);
    assert.equal(RULES_SCHEMA, 1);
});

test('rules must be an object', () => {
    for (const bad of ['prone', 3, true, [], [{ schema: 1 }]]) {
        assert.deepEqual(validateRules(bad), ['rules must be an object'], JSON.stringify(bad));
        assert.equal(normalizeRules(bad), null);
    }
});

test('unknown fields are reported, at every level', () => {
    assertProblems(validateRules({ roll: [], mechanic: [] }), ['unknown fields "roll", "mechanic" (known: schema, mechanics, rolls, links, longRest, endsWhen, duration)']);
    assertProblems(validateRules({ mechanics: [{ kind: 'movement', op: 'half', types: ['walk'] }] }), ['mechanics[0]: unknown field "types" for kind "movement"']);
    assertProblems(validateRules({ mechanics: [{ kind: 'skillModifier', amount: -1, attribute: 'str' }] }), [
        'mechanics[0]: unknown field "attribute" for kind "skillModifier"',
    ]);
    // A qualifier this version can't read must not be dropped: the rule would then apply too widely.
    assertProblems(validateRules({ rolls: [{ who: 'self', mode: 'advantage', tests: 'all', unless: ['test:attack'] }] }), ['rolls[0]: unknown field "unless"']);
    // `when` is read since #7; a fact this version doesn't know is refused the same way (test/predicates.test.js).
    assertProblems(validateRules({ rolls: [{ who: 'self', mode: 'advantage', tests: 'all', when: ['target:prone'] }] }), ['rolls[0]: when[0]: unknown fact "target:prone"']);
    assertProblems(validateRules({ rolls: [{ who: 'self', mode: 'advantage', tests: { skills: ['prc'], attribute: 'str' } }] }), [
        'rolls[0]: tests: unknown field "attribute"',
    ]);
    assertProblems(validateRules({ duration: { kinds: ['endOfTurn'], turnOf: 'Actor.x' } }), ['duration: unknown field "turnOf"']);
});

test('invalid mechanics are reported', () => {
    const problems = validateRules(
        {
            mechanics: [
                'halfMovement',
                { kind: 'teleport' },
                { op: 'half' },
                { kind: 'movement' },
                { kind: 'movement', op: 'double' },
                { kind: 'skillModifier' },
                { kind: 'skillModifier', amount: 0 },
                { kind: 'skillModifier', amount: 1.5 },
                { kind: 'skillModifier', amount: '-1' },
                { kind: 'skillModifier', amount: -1, perStack: 'yes' },
                { kind: 'skillModifier', amount: -1, skills: 'prc' },
                { kind: 'skillModifier', amount: -1, skills: [] },
                { kind: 'skillModifier', amount: -1, skills: ['prc', 7, ''] },
                { kind: 'skillModifier', amount: -1, skills: ['stealthy'] },
                { kind: 'attributeBonus' },
                { kind: 'attributeBonus', attribute: 'str' },
                { kind: 'attributeBonus', attribute: 'str', amount: 0 },
                { kind: 'attributeBonus', attribute: 'luck', amount: 1 },
                { kind: 'attributeBonus', from: 'stacks' },
                { kind: 'attributeBonus', from: 'value', attribute: 'str', amount: 1 },
                { kind: 'constructor' },
            ],
        },
        known,
    );
    assertProblems(problems, [
        'mechanics[0]: must be an object like { kind: "movement", op: "half" }',
        'mechanics[1]: unknown kind "teleport" (known: movement, skillModifier, attributeBonus)',
        'mechanics[2]: unknown kind undefined',
        'mechanics[3]: unknown op undefined (known: zero, half)',
        'mechanics[4]: unknown op "double"',
        'mechanics[5]: amount must be a whole number other than 0',
        'mechanics[6]: amount must be',
        'mechanics[7]: amount must be',
        'mechanics[8]: amount must be',
        'mechanics[9]: perStack must be true or false',
        'mechanics[10]: skills: must be a list of skill ids',
        'mechanics[11]: skills: an empty list changes nothing',
        'mechanics[12]: skills: 7 is not a skill id',
        'mechanics[12]: skills: "" is not a skill id',
        'mechanics[13]: skills: unknown skill "stealthy"',
        'mechanics[14]: needs an attribute id and an amount, or from: "value"',
        'mechanics[15]: amount must be',
        'mechanics[16]: amount must be',
        'mechanics[17]: unknown attribute "luck"',
        'mechanics[18]: unknown from "stacks"',
        'mechanics[19]: give either from: "value" or attribute and amount, not both',
        'mechanics[20]: unknown kind "constructor"',
    ]);
    for (let i = 0; i <= 20; i++) assert.ok(problems.some((p) => p.startsWith(`mechanics[${i}]:`)), `mechanics[${i}] is reported`);
    assert.deepEqual(validateRules({ mechanics: { kind: 'movement', op: 'half' } }), ['mechanics: must be a list ([] for none)']);
    assert.deepEqual(Object.values(MECHANIC_KINDS), ['movement', 'skillModifier', 'attributeBonus']);
});

test('invalid roll rules are reported, with the roll layer\'s own messages', () => {
    const problems = validateRules(
        {
            rolls: [
                'advantage',
                { who: 'ally', mode: 'advantage', tests: 'all' },
                { who: 'self', mode: 'lucky', tests: 'all' },
                { who: 'self', mode: 'advantage', tests: 'thrown' },
                { who: 'self', mode: 'advantage' },
                { who: 'self', mode: 'advantage', tests: { skills: [] } },
                { who: 'self', mode: 'advantage', tests: { skills: ['prc', 5] } },
                { who: 'self', mode: 'advantage', tests: { skills: ['stealthy'] } },
                { who: 'target', mode: 'advantage', tests: 'all', vsTarget: true },
                { who: 'target', mode: 'disadvantage', tests: 'attack', beyondSenses: true },
                { who: 'self', mode: 'advantage', tests: 'all', consume: 'yes' },
            ],
        },
        known,
    );
    assertProblems(problems, [
        'rolls[0]: rule must be an object',
        'rolls[1]: unknown "who" "ally"',
        'rolls[2]: unknown mode "lucky"',
        'rolls[3]: unknown tests "thrown"',
        'rolls[4]: unknown tests undefined',
        'rolls[5]: unknown tests {"skills":[]}',
        'rolls[6]: tests.skills: 5 is not a skill id',
        'rolls[7]: tests.skills: unknown skill "stealthy"',
        'rolls[8]: vsTarget only makes sense for who: self',
        'rolls[9]: beyondSenses only makes sense for who: self',
        'rolls[10]: consume must be true or false',
    ]);
    assert.deepEqual(validateRules({ rolls: { who: 'self', mode: 'advantage', tests: 'all' } }), ['rolls: must be a list ([] for none)']);
});

test('invalid links, longRest, endsWhen and duration are reported', () => {
    assertProblems(validateRules({ links: 'slowed' }), ['links: must be a list ([] for none)']);
    assertProblems(validateRules({ links: ['slowed', '', 4] }), ['links: "" is not a condition id', 'links: 4 is not a condition id']);
    assertProblems(validateRules({ links: ['slowed', 'pinned'] }, known), ['links: unknown condition "pinned"']);
    assert.deepEqual(validateRules({ links: ['slowed', 'pinned'] }), [], 'ids are only checked against a list when one is given');

    for (const longRest of [-1, 1.5, '1', true, [1]]) {
        assert.deepEqual(validateRules({ longRest }), ['longRest: must be a whole number of stacks, 0 or more'], JSON.stringify(longRest));
    }

    assertProblems(validateRules({ endsWhen: 'move' }), ['endsWhen: must be a list ([] for none)']);
    assertProblems(validateRules({ endsWhen: ['move', 'sneeze'] }), ['endsWhen: unknown trigger "sneeze" (known: attack, move)']);
    assert.deepEqual(ENDS_WHEN, ['attack', 'move']);

    assertProblems(validateRules({ duration: ['soon'] }), ['duration: unknown duration kind "soon"']);
    assertProblems(validateRules({ duration: 3 }), ['duration: must be a duration kind, a list of kinds or { kinds, days }']);
    assertProblems(validateRules({ duration: { days: 3 } }), ['duration: must be a duration kind, a list of kinds or { kinds, days }']);
    assertProblems(validateRules({ duration: ['endOfScene', 2] }), ['duration: 2 is not a duration kind']);
    assertProblems(validateRules({ duration: ['days'] }), ['duration: a duration in days needs days ≥ 1']);
    assertProblems(validateRules({ duration: { kinds: ['days'], days: 0 } }), ['duration: a duration in days needs days ≥ 1']);
    assertProblems(validateRules({ duration: { kinds: ['days'], days: '3' } }), ['duration: days must be a number']);
    assertProblems(validateRules({ duration: { kinds: ['endOfScene'], days: 3 } }), ['duration: days is only for the "days" kind']);
});

test('invalid rules never normalize, and nothing throws', () => {
    const invalid = [
        { mechanics: [{ kind: 'movement', op: 'double' }] },
        { rolls: [{ who: 'self', mode: 'advantage', tests: 'all' }], links: [7] },
        { longRest: -1 },
        { mechanics: [null], rolls: [null], links: [null], endsWhen: [null], duration: [null] },
        { mechanics: [{ kind: 'skillModifier', amount: -1, skills: [{}] }], rolls: [{ who: 'self', mode: 'advantage', tests: { skills: [null] } }] },
    ];
    for (const rules of invalid) {
        const parsed = parseRules(rules, known);
        assert.equal(parsed.ok, false, JSON.stringify(rules));
        assert.equal(parsed.rules, null);
        assert.ok(parsed.problems.length > 0);
        assert.equal(normalizeRules(rules), null);
    }
    assert.equal(parseRules(invalid[3]).problems.length, 5, 'one problem per broken field');
});

test('parseRules gives the problems and the clean copy together', () => {
    assert.deepEqual(parseRules({ links: ['slowed'] }, known), { ok: true, rules: { schema: 1, links: ['slowed'] }, problems: [] });
    // The known ids may be any iterable.
    assert.deepEqual(validateRules({ links: ['slowed'] }, { conditions: new Set(['slowed']) }), []);
    assert.deepEqual(validateRules({ links: ['slowed'] }, { conditions: new Set(['prone']) }), ['links: unknown condition "slowed"']);
});
