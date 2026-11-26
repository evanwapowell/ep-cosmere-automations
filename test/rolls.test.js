import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONDITIONS, CONDITIONS_BY_ID } from '../data/conditions.js';
import { SITUATIONAL, SITUATIONAL_BY_ID } from '../data/situational.js';
import { collectModifiers, describeModifiers, netMode, ruleError, ruleMatchesTest } from '../scripts/logic/rolls.js';
import { validateSituational } from '../scripts/logic/table.js';

const full = () => 'full';
const sources = { conditions: CONDITIONS_BY_ID, situational: SITUATIONAL_BY_ID, modeOf: full };
const side = (over = {}) => ({ uuid: 'Actor.a', name: 'A', conditions: [], situational: [], stance: null, ...over });
const skill = (id) => ({ context: 'Skill', skill: id, attackType: null });
const melee = { context: 'Attack', skill: 'hwp', attackType: 'melee' };
const ranged = { context: 'Attack', skill: 'lwp', attackType: 'ranged' };
const keys = (mods) => mods.map((m) => `${m.side}:${m.key}:${m.mode}`).sort();

test('the situational table is valid and does not clash with condition ids', () => {
    assert.deepEqual(validateSituational(SITUATIONAL, new Set(CONDITIONS.map((c) => c.id))), []);
});

test('situational validation catches bad entries', () => {
    const errors = validateSituational([
        { id: 'x', name: 'X', summary: 's', rolls: [] },
        { id: 'y', name: 'Y', summary: 's', action: 'a', stance: 'b', rolls: [{ who: 'self', mode: 'advantage', tests: 'all', vsTarget: true }] },
        { id: 'z', name: 'Z', summary: 's', action: 'a', rolls: [{ who: 'them', mode: 'advantage', tests: 'all' }], endsWhen: ['sneeze'] },
    ]).join('\n');
    for (const fragment of ['needs exactly one of action or stance', 'no roll rules', 'vsTarget needs needsTarget', 'action "a" used twice', 'unknown "who"', 'unknown endsWhen']) {
        assert.ok(errors.includes(fragment), `expected "${fragment}" in:\n${errors}`);
    }
});

test('ruleError and ruleMatchesTest', () => {
    assert.equal(ruleError({ who: 'self', mode: 'advantage', tests: { skills: ['inm'] } }), null);
    assert.match(ruleError({ who: 'self', mode: 'advantage', tests: { skills: [] } }), /unknown tests/);
    assert.match(ruleError({ who: 'target', mode: 'advantage', tests: 'all', vsTarget: true }), /vsTarget/);
    assert.equal(ruleMatchesTest({ tests: 'melee' }, melee), true);
    assert.equal(ruleMatchesTest({ tests: 'melee' }, ranged), false);
    assert.equal(ruleMatchesTest({ tests: 'attack' }, skill('ath')), false);
    assert.equal(ruleMatchesTest({ tests: { skills: ['prc'] } }, skill('prc')), true);
    assert.equal(ruleMatchesTest({ tests: { skills: ['prc'] } }, { context: 'Skill', skill: null }), false);
});

test('Restrained: disadvantage on every test; Empowered: advantage', () => {
    const restrained = collectModifiers({ roller: side({ conditions: ['restrained'] }), target: null, test: skill('ath') }, sources);
    assert.deepEqual(keys(restrained), ['self:restrained:disadvantage']);
    const both = collectModifiers({ roller: side({ conditions: ['restrained', 'empowered'] }), target: null, test: melee }, sources);
    assert.equal(netMode('none', both), 'none', 'one advantage cancels one disadvantage');
});

test('Disoriented: Perception only', () => {
    const roller = side({ conditions: ['disoriented'] });
    assert.equal(collectModifiers({ roller, target: null, test: skill('prc') }, sources).length, 1);
    assert.equal(collectModifiers({ roller, target: null, test: skill('ath') }, sources).length, 0);
});

test('Prone target: melee attacks gain an advantage, ranged do not; the roller being Prone does not count', () => {
    const target = side({ uuid: 'Actor.t', conditions: ['prone'] });
    assert.deepEqual(keys(collectModifiers({ roller: side(), target, test: melee }, sources)), ['target:prone:advantage']);
    assert.deepEqual(collectModifiers({ roller: side(), target, test: ranged }, sources), []);
    assert.deepEqual(collectModifiers({ roller: side({ conditions: ['prone'] }), target: null, test: melee }, sources), []);
});

test('Flying target: ranged attacks gain a disadvantage', () => {
    const target = side({ uuid: 'Actor.t', conditions: ['flying'] });
    assert.deepEqual(keys(collectModifiers({ roller: side(), target, test: ranged }, sources)), ['target:flying:disadvantage']);
    assert.deepEqual(collectModifiers({ roller: side(), target, test: melee }, sources), []);
});

test('several instances of a condition count once', () => {
    const roller = side({ conditions: ['restrained', 'restrained'] });
    assert.equal(collectModifiers({ roller, target: null, test: skill('ath') }, sources).length, 1);
});

test('Dodging target: attack disadvantage, used up', () => {
    const target = side({ uuid: 'Actor.t', situational: [{ id: 'dodging', effectId: 'e1' }] });
    const mods = collectModifiers({ roller: side(), target, test: melee }, sources);
    assert.deepEqual(keys(mods), ['target:situational:dodging:disadvantage']);
    assert.deepEqual(mods[0].consume, { actorUuid: 'Actor.t', effectId: 'e1' });
    assert.deepEqual(collectModifiers({ roller: side(), target, test: skill('ath') }, sources), [], 'not on skill tests');
});

test('Advantage gained: only against that target, used up', () => {
    const roller = side({ situational: [{ id: 'advantage', effectId: 'e2', value: { targetUuid: 'Actor.t', targetName: 'Brute' } }] });
    const brute = side({ uuid: 'Actor.t' });
    const other = side({ uuid: 'Actor.o' });
    const vsBrute = collectModifiers({ roller, target: brute, test: skill('ded') }, sources);
    assert.deepEqual(keys(vsBrute), ['self:situational:advantage:advantage']);
    assert.equal(vsBrute[0].label, 'Advantage gained (Brute)');
    assert.deepEqual(vsBrute[0].consume, { actorUuid: 'Actor.a', effectId: 'e2' });
    assert.deepEqual(collectModifiers({ roller, target: other, test: skill('ded') }, sources), []);
    assert.deepEqual(collectModifiers({ roller, target: null, test: skill('ded') }, sources), []);
});

test('Flamestance: advantage on Intimidation while in the stance', () => {
    const roller = side({ stance: 'flamestance' });
    assert.equal(collectModifiers({ roller, target: null, test: skill('inm') }, sources).length, 1);
    assert.equal(collectModifiers({ roller, target: null, test: skill('prs') }, sources).length, 0);
    assert.equal(collectModifiers({ roller: side({ stance: 'stonestance' }), target: null, test: skill('inm') }, sources).length, 0);
});

test('modes: off drops a source, remind shows it without applying', () => {
    const roller = side({ conditions: ['restrained', 'empowered'] });
    const modeOf = (key) => (key === 'restrained' ? 'remind' : key === 'empowered' ? 'off' : 'full');
    const mods = collectModifiers({ roller, target: null, test: skill('ath') }, { ...sources, modeOf });
    assert.deepEqual(mods.map((m) => [m.key, m.active]), [['restrained', false]]);
    assert.equal(netMode('none', mods), 'none');
    assert.equal(describeModifiers(mods), 'Not applied (remind only): Restrained (disadvantage).');
});

test('netMode: the caller\'s choice counts as one', () => {
    const dis = { mode: 'disadvantage', active: true };
    const adv = { mode: 'advantage', active: true };
    assert.equal(netMode('none', []), 'none');
    assert.equal(netMode('advantage', [dis]), 'none');
    assert.equal(netMode('advantage', [dis, dis]), 'disadvantage');
    assert.equal(netMode('none', [adv, adv, dis]), 'advantage');
    assert.equal(netMode(undefined, [dis]), 'disadvantage');
});

test('describeModifiers', () => {
    const mods = [
        { label: 'Prone', mode: 'advantage', active: true, side: 'target' },
        { label: 'Restrained', mode: 'disadvantage', active: true, side: 'self' },
    ];
    assert.equal(describeModifiers(mods), 'Advantage: target Prone. Disadvantage: Restrained.');
    assert.equal(describeModifiers([]), '');
});
