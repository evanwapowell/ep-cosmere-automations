import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONDITIONS, CONDITIONS_BY_ID } from '../data/conditions.js';
import { SITUATIONAL, SITUATIONAL_BY_ID } from '../data/situational.js';
import { planAdjustments } from '../scripts/logic/mechanics.js';
import { collectModifiers, rollSources } from '../scripts/logic/rolls.js';
import { defaultDuration, defaultRules, entryToRules, resolveRules } from '../scripts/logic/rules.js';

const ROLL = { who: 'self', mode: 'disadvantage', tests: 'ranged' };
const known = { conditions: CONDITIONS.map((c) => c.id) };

test('resolveRules: with no own rules the table entry is the rules', () => {
    for (const entry of [...CONDITIONS, ...SITUATIONAL]) {
        const { rules, problems } = resolveRules(undefined, entry);
        assert.deepEqual(rules, entryToRules(entry), entry.id);
        assert.deepEqual(problems, []);
    }
    assert.deepEqual(resolveRules(null, null), { rules: { schema: 1 }, problems: [] }, 'no entry, no rules');
    assert.deepEqual(resolveRules({ rolls: [ROLL] }, null).rules, { schema: 1, rolls: [ROLL] }, 'own rules without defaults');
});

test('resolveRules: each field the effect sets replaces the default; the others keep it', () => {
    const exhausted = CONDITIONS_BY_ID.exhausted;
    const defaults = entryToRules(exhausted);
    assert.ok(defaults.mechanics?.length && defaults.longRest, 'the fixture needs mechanics and a long-rest step');

    const { rules, problems } = resolveRules({ rolls: [ROLL] }, exhausted);
    assert.deepEqual(problems, []);
    assert.deepEqual(rules.rolls, [ROLL], 'the own rolls');
    assert.deepEqual(rules.mechanics, defaults.mechanics, 'the default mechanics');
    assert.equal(rules.longRest, defaults.longRest, 'the default long-rest step');
});

test('resolveRules: an empty list or 0 is a setting, and beats the default', () => {
    const prone = CONDITIONS_BY_ID.prone;
    assert.ok(entryToRules(prone).links?.length);
    assert.deepEqual(resolveRules({ links: [] }, prone).rules.links, []);
    assert.equal(resolveRules({ longRest: 0 }, CONDITIONS_BY_ID.exhausted).rules.longRest, 0);
    assert.deepEqual(resolveRules({ mechanics: [] }, CONDITIONS_BY_ID.slowed).rules.mechanics, []);
    assert.equal(resolveRules({ longRest: null }, CONDITIONS_BY_ID.exhausted).rules.longRest, 1, 'null is not set');
});

test('resolveRules: duration and endsWhen resolve like the rest', () => {
    const dodging = SITUATIONAL_BY_ID.dodging;
    const own = resolveRules({ duration: ['endOfScene'], endsWhen: ['move'] }, dodging).rules;
    assert.deepEqual(own.duration, ['endOfScene']);
    assert.deepEqual(own.endsWhen, ['move']);
    assert.deepEqual(own.rolls, entryToRules(dodging).rolls);
    assert.deepEqual(resolveRules({ endsWhen: [] }, dodging).rules.endsWhen, []);
});

test('resolveRules: invalid own rules are ignored as a whole and reported, never thrown', () => {
    const exhausted = CONDITIONS_BY_ID.exhausted;
    // One good field and one bad one: the good one is not applied in part either.
    const own = { longRest: 3, rolls: [{ who: 'self', mode: 'sideways', tests: 'all' }] };
    const { rules, problems } = resolveRules(own, exhausted);
    assert.deepEqual(rules, entryToRules(exhausted));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /rolls\[0\]/);

    for (const bad of ['text', 5, [], { schema: 2 }, { roll: [] }]) {
        assert.doesNotThrow(() => resolveRules(bad, exhausted));
        assert.deepEqual(resolveRules(bad, exhausted).rules, entryToRules(exhausted));
        assert.ok(resolveRules(bad, exhausted).problems.length > 0);
    }
});

test('resolveRules: known ids are checked when given', () => {
    const own = { links: ['nonsense'] };
    assert.deepEqual(resolveRules(own, null).problems, []);
    assert.equal(resolveRules(own, null, known).problems.length, 1);
    assert.deepEqual(resolveRules(own, CONDITIONS_BY_ID.prone, known).rules.links, ['slowed'], 'falls back to the default');
});

test('defaultDuration: the duration resolved rules start with, if any', () => {
    assert.deepEqual(defaultDuration(entryToRules(SITUATIONAL_BY_ID.dodging)), SITUATIONAL_BY_ID.dodging.duration);
    assert.equal(defaultDuration({ schema: 1 }), undefined);
    assert.equal(defaultDuration({ schema: 1, duration: [] }), undefined);
    assert.equal(defaultDuration(null), undefined);
    const days = { kinds: ['days'], days: 2 };
    assert.deepEqual(defaultDuration({ schema: 1, duration: days }), days);
});

test("planAdjustments: an effect's resolved rules decide, not the table", () => {
    const all = () => true;
    const plan = (rules) => planAdjustments([{ id: 'exhausted', stacks: 3, rules }], CONDITIONS_BY_ID, all);
    assert.equal(plan(undefined).skillPenalty, 3, 'the table: a penalty per stack');

    const swapped = plan(resolveRules({ mechanics: [{ kind: 'movement', op: 'zero' }] }, CONDITIONS_BY_ID.exhausted).rules);
    assert.equal(swapped.skillPenalty, 0);
    assert.deepEqual(swapped.noMovement, ['exhausted']);

    const flat = plan(resolveRules({ mechanics: [{ kind: 'skillModifier', amount: -2, skills: 'all' }] }, CONDITIONS_BY_ID.exhausted).rules);
    assert.equal(flat.skillPenalty, 2, 'not per stack');
});

test("collectModifiers: an effect's resolved rules decide, not the table", () => {
    const sources = { modeOf: () => 'full' };
    const test_ = { context: 'Attack', attackType: 'ranged' };
    // A condition id alone: the table's rules (an effect with none of its own); {id, rules}: resolved rules.
    const rows = (conditions) =>
        conditions.map((item, i) => {
            const id = typeof item === 'string' ? item : item.id;
            return { effect: { id: `e${i}` }, conditionId: id, rules: typeof item === 'string' ? defaultRules(CONDITIONS_BY_ID[id]) : item.rules };
        });
    const run = (conditions) =>
        collectModifiers(
            { roller: { uuid: 'a', name: 'A', sources: rollSources(rows(conditions), { conditions: CONDITIONS_BY_ID, situational: SITUATIONAL_BY_ID }) }, target: null, test: test_ },
            sources,
        );

    assert.deepEqual(run(['prone']).map((m) => m.key), [], 'Prone has no roll rule for the roller');
    const rules = resolveRules({ rolls: [ROLL] }, CONDITIONS_BY_ID.prone).rules;
    assert.deepEqual(run([{ id: 'prone', rules }]).map((m) => [m.key, m.mode]), [['prone', 'disadvantage']]);
    assert.deepEqual(run([{ id: 'restrained', rules: { schema: 1 } }]).map((m) => m.key), [], 'resolved rules with no rolls');
    assert.ok(run(['restrained']).length > 0, 'a plain id still reads the table');
});
