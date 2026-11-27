/**
 * Authoring's pure parts: where each resolved field comes from, and reading the Rules dialog's editor text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONDITIONS_BY_ID } from '../data/conditions.js';
import { parseRulesText, rulesRows, rulesText } from '../scripts/logic/authoring.js';
import { entryToRules, explainRules, validateRules } from '../scripts/logic/rules.js';

const KNOWN = { conditions: Object.keys(CONDITIONS_BY_ID) };

test('explainRules: no own rules, every field from the defaults', () => {
    const report = explainRules(undefined, CONDITIONS_BY_ID.exhausted, KNOWN);
    assert.deepEqual(report.rules, entryToRules(CONDITIONS_BY_ID.exhausted));
    assert.deepEqual(report.defaults, entryToRules(CONDITIONS_BY_ID.exhausted));
    assert.equal(report.own, null);
    assert.deepEqual(report.problems, []);
    const fields = Object.keys(report.rules).filter((f) => f !== 'schema');
    assert.ok(fields.length > 0);
    assert.deepEqual(Object.keys(report.from).sort(), fields.sort());
    assert.ok(Object.values(report.from).every((from) => from === 'default'));
});

test('explainRules: own fields win and are marked as the effect\'s', () => {
    const own = { mechanics: [{ kind: 'movement', op: 'half' }], longRest: 0 };
    const report = explainRules(own, CONDITIONS_BY_ID.exhausted, KNOWN);
    assert.equal(report.from.mechanics, 'effect');
    assert.equal(report.from.longRest, 'effect', 'a field set to 0 is set');
    assert.equal(report.rules.longRest, 0);
    assert.deepEqual(report.own, { schema: 1, mechanics: [{ kind: 'movement', op: 'half', }], longRest: 0 });
    assert.deepEqual(report.defaults, entryToRules(CONDITIONS_BY_ID.exhausted), 'the defaults are shown as they are');
});

test('explainRules: invalid own rules are reported and the defaults stand', () => {
    const report = explainRules({ links: ['nonsense'] }, CONDITIONS_BY_ID.prone, KNOWN);
    assert.equal(report.own, null);
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0], /links/);
    assert.deepEqual(report.rules, entryToRules(CONDITIONS_BY_ID.prone));
    assert.ok(Object.values(report.from).every((from) => from === 'default'));
});

test('explainRules: an effect with no table entry has only its own fields', () => {
    const report = explainRules({ rolls: [{ who: 'self', mode: 'advantage', tests: { skills: ['ath'] } }] }, null, KNOWN);
    assert.deepEqual(report.from, { rolls: 'effect' });
    assert.deepEqual(report.defaults, { schema: 1 });
});

test('parseRulesText: blank or null is "no rules of its own"', () => {
    const check = () => assert.fail('not called');
    assert.deepEqual(parseRulesText('', check), { ok: true, rules: null, problems: [] });
    assert.deepEqual(parseRulesText('   \n', check), { ok: true, rules: null, problems: [] });
    assert.deepEqual(parseRulesText('null', check), { ok: true, rules: null, problems: [] });
});

test('parseRulesText: bad JSON is a problem, not a throw', () => {
    const result = parseRulesText('{ mechanics: [', validateRules);
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /not valid JSON/);
});

test('parseRulesText: the validator\'s problems come through', () => {
    const bad = parseRulesText('{"longRest": -1}', (r) => validateRules(r, KNOWN));
    assert.equal(bad.ok, false);
    assert.match(bad.problems[0], /longRest/);
    const good = parseRulesText('{"mechanics": [{"kind": "movement", "op": "half"}], "links": ["slowed"]}', (r) => validateRules(r, KNOWN));
    assert.equal(good.ok, true);
    assert.deepEqual(good.rules.links, ['slowed']);
});

test('rulesText and rulesRows', () => {
    assert.equal(rulesText(null), '');
    assert.equal(rulesText(undefined), '');
    assert.deepEqual(JSON.parse(rulesText({ longRest: 1 })), { longRest: 1 });
    const report = explainRules({ longRest: 2 }, CONDITIONS_BY_ID.exhausted, KNOWN);
    const rows = rulesRows(report);
    assert.deepEqual(rows.find((r) => r.field === 'longRest'), { field: 'longRest', from: 'effect', json: '2' });
    assert.ok(rows.every((r) => r.field !== 'schema'));
});
