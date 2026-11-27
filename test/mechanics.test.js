/**
 * The mechanics layer's plan from rule rows (#4): any effect's `rules.mechanics`, not only the table's conditions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONDITIONS_BY_ID } from '../data/conditions.js';
import { adjustedRate, planAdjustments, skillDelta } from '../scripts/logic/mechanics.js';
import { entryToRules, normalizeRules } from '../scripts/logic/rules.js';
import { valueEffectData } from '../scripts/logic/values.js';

const row = (key, mechanics, extra = {}) => ({ key, rules: normalizeRules({ mechanics }), ...extra });
const HALF = [{ kind: 'movement', op: 'half' }];

test('a non-condition effect that halves movement halves it in full mode and does nothing otherwise', () => {
    const rows = [row('Actor.a.Item.t.ActiveEffect.e', HALF)];
    assert.equal(adjustedRate(30, planAdjustments(rows)), 15, 'every row is full by default');
    assert.equal(adjustedRate(30, planAdjustments(rows, () => true)), 15);
    const remind = planAdjustments(rows, () => false);
    assert.equal(adjustedRate(30, remind), 30);
    assert.deepEqual(remind.halfMovement, []);
});

test('the mode is asked per row', () => {
    const rows = [row('slowed', HALF, { conditionId: 'slowed' }), row('talent', [{ kind: 'movement', op: 'zero' }])];
    const plan = planAdjustments(rows, (r) => r.conditionId === 'slowed');
    assert.deepEqual(plan.halfMovement, ['slowed']);
    assert.deepEqual(plan.noMovement, []);
});

test('stacking: several halves halve once, zero beats half, a key is listed once', () => {
    const plan = planAdjustments([row('a', HALF), row('b', HALF), row('a', HALF)]);
    assert.deepEqual(plan.halfMovement, ['a', 'b']);
    assert.equal(adjustedRate(40, plan), 20);
    const zero = planAdjustments([row('a', HALF), row('b', [{ kind: 'movement', op: 'zero' }])]);
    assert.equal(adjustedRate(40, zero), 0);
});

test('skill modifiers add up; perStack multiplies by stacks; all-skills and listed skills both count', () => {
    const plan = planAdjustments([
        row('exhausted', entryToRules(CONDITIONS_BY_ID.exhausted).mechanics, { stacks: 2 }),
        row('focus', [{ kind: 'skillModifier', amount: 2, skills: ['prc', 'ins'] }]),
        row('glare', [{ kind: 'skillModifier', amount: -1, skills: ['prc'] }]),
        row('dazed', [{ kind: 'skillModifier', amount: -1, perStack: true, skills: ['ath'] }], { stacks: 3 }),
    ]);
    assert.equal(plan.skillPenalty, 2);
    assert.deepEqual(plan.penaltySources, ['exhausted']);
    assert.deepEqual(plan.skillModifiers, { prc: 1, ins: 2, ath: -3 });
    assert.equal(skillDelta(plan, 'prc'), -1, '+2 −1 listed, −2 for all');
    assert.equal(skillDelta(plan, 'ins'), 0);
    assert.equal(skillDelta(plan, 'ath'), -5);
    assert.equal(skillDelta(plan, 'agi'), -2);
    assert.equal(skillDelta(planAdjustments([]), 'agi'), 0);
});

test('an all-skills bonus is a negative penalty', () => {
    const plan = planAdjustments([row('blessing', [{ kind: 'skillModifier', amount: 1, skills: 'all' }])]);
    assert.equal(plan.skillPenalty, -1);
    assert.equal(skillDelta(plan, 'ath'), 1);
});

test('fixed attribute bonuses add up; from: value is left to the value path (Enhanced)', () => {
    const plan = planAdjustments([
        row('a', [{ kind: 'attributeBonus', attribute: 'spd', amount: 1 }]),
        row('b', [{ kind: 'attributeBonus', attribute: 'spd', amount: 2 }, { kind: 'attributeBonus', attribute: 'str', amount: -1 }]),
        row('enhanced', [{ kind: 'attributeBonus', from: 'value' }], { value: { attribute: 'str', amount: 3 } }),
    ]);
    assert.deepEqual(plan.attributeBonuses, { spd: 3, str: -1 });
});

test('rows without mechanics, or without rules, change nothing', () => {
    const plan = planAdjustments([{ key: 'x', rules: { schema: 1 } }, { key: 'y', rules: null }, null]);
    assert.deepEqual(plan, { noMovement: [], halfMovement: [], skillPenalty: 0, penaltySources: [], skillModifiers: {}, attributeBonuses: {} });
});

test('the table form still works: ids, table defaults, mode by id', () => {
    const plan = planAdjustments([{ id: 'slowed' }, { id: 'exhausted', stacks: 2 }], CONDITIONS_BY_ID, (id) => id === 'exhausted');
    assert.deepEqual(plan.halfMovement, []);
    assert.equal(plan.skillPenalty, 2);
});

test('Enhanced is an attributeBonus record, and the value path writes it as an effect change', () => {
    const entry = CONDITIONS_BY_ID.enhanced;
    assert.deepEqual(entryToRules(entry).mechanics, [{ kind: 'attributeBonus', from: 'value' }]);
    const data = valueEffectData(entry, { attribute: 'str', amount: 1 }, { baseName: 'Enhanced', full: true, flagScope: 'm' });
    assert.deepEqual(data.changes, [{ key: 'system.attributes.str.bonus', mode: 2, value: '1' }]);
    const without = valueEffectData(entry, { attribute: 'str', amount: 1 }, { baseName: 'Enhanced', full: true, flagScope: 'm', rules: { schema: 1, mechanics: [] } });
    assert.equal(without.changes, undefined, 'own rules without the record write no change');
});
