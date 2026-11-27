import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONDITIONS, CONDITIONS_BY_ID } from '../data/conditions.js';
import { SITUATIONAL, SITUATIONAL_BY_ID } from '../data/situational.js';
import { attackTypeOf, beyondSenses, collectModifiers, describeModifiers, netMode, ruleError, ruleMatchesTest, rollSources, sideSources, stanceSource } from '../scripts/logic/rolls.js';
import { defaultRules } from '../scripts/logic/rules.js';
import { validateSituational } from '../scripts/logic/table.js';

const full = () => 'full';
const sources = { modeOf: full };
const TABLES = { conditions: CONDITIONS_BY_ID, situational: SITUATIONAL_BY_ID };
/**
 * A side as `sideOf` builds it, from condition ids, situational effects and a stance, each with the table's
 * rules (what effects with no rules of their own resolve to).
 */
const side = ({ uuid = 'Actor.a', name = 'A', conditions = [], situational = [], effects = [], stance = null } = {}) => {
    const rows = [
        ...conditions.map((id, i) => ({ effect: { id: `c${i}`, name: id }, rules: defaultRules(CONDITIONS_BY_ID[id]), conditionId: id })),
        ...situational.map(({ id, effectId, value }) => ({ effect: { id: effectId, name: id }, rules: defaultRules(SITUATIONAL_BY_ID[id]), situationalId: id, value })),
        ...effects,
    ];
    return { uuid, name, sources: sideSources(rows, { stance, ...TABLES }) };
};
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

test('beyondSenses: only a measured target farther than the senses range; senses not affected by obscurement never', () => {
    assert.equal(beyondSenses({ distance: 20, sensesRange: 10 }), true);
    assert.equal(beyondSenses({ distance: 10, sensesRange: 10 }), false, 'at the edge: within');
    assert.equal(beyondSenses({ distance: null, sensesRange: 10 }), null);
    assert.equal(beyondSenses({ distance: 20, sensesRange: 10, obscuredAffected: false }), false);
    const blind = { who: 'self', mode: 'disadvantage', tests: 'attack', beyondSenses: true };
    assert.equal(ruleMatchesTest(blind, { context: 'Attack', beyondSenses: true }), true);
    assert.equal(ruleMatchesTest(blind, { context: 'Attack', beyondSenses: null }), false, 'not measured: skipped');
    assert.equal(ruleMatchesTest(blind, { context: 'Skill', beyondSenses: true }), false);
    assert.match(ruleError({ ...blind, who: 'target' }), /beyondSenses/);
});

test('attackTypeOf: the item, its parent weapon, or an adversary description', () => {
    assert.equal(attackTypeOf({ system: { attack: { type: 'ranged' } } }), 'ranged');
    assert.equal(attackTypeOf({ system: {}, parent: { system: { attack: { type: 'melee' } } } }), 'melee');
    assert.equal(attackTypeOf({ system: { description: { value: '<p>Attack +4; Reach 5 ft.; Targets one</p>' } } }), 'melee');
    assert.equal(attackTypeOf({ system: { description: { value: 'Attack +2; Range 80/120 ft.' } } }), 'ranged');
    assert.equal(attackTypeOf({ system: { description: { value: 'Reach 5 ft. or Range 20/60 ft.' } } }), null, 'both: unknown');
    assert.equal(attackTypeOf({ system: { description: { value: 'Outreach program' } } }), null, 'whole words only');
    assert.equal(attackTypeOf({ system: {}, parent: { system: {} } }), null);
    assert.equal(attackTypeOf(null), null);
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

/* --- Rules on any effect (step 4 of portable rules) --- */

const plain = (id, name, rolls, extra = {}) => ({ effect: { id, name }, rules: { schema: 1, rolls }, ...extra });

test('a plain effect with its own roll rule: disadvantage on ranged attacks, not on melee; labelled with its name', () => {
    const roller = side({ effects: [plain('E1', 'Shaky Hands', [{ who: 'self', mode: 'disadvantage', tests: 'ranged' }])] });
    const mods = collectModifiers({ roller, target: null, test: ranged }, sources);
    assert.deepEqual(keys(mods), ['self:effect:E1:disadvantage']);
    assert.equal(mods[0].label, 'Shaky Hands');
    assert.equal(netMode('none', mods), 'disadvantage');
    assert.deepEqual(collectModifiers({ roller, target: null, test: melee }, sources), []);
});

test('a plain effect on the target: who "target" rules apply to tests against it', () => {
    const target = side({ uuid: 'Actor.t', effects: [plain('E2', 'Smoke', [{ who: 'target', mode: 'disadvantage', tests: 'attack' }])] });
    assert.deepEqual(keys(collectModifiers({ roller: side(), target, test: melee }, sources)), ['target:effect:E2:disadvantage']);
    assert.deepEqual(collectModifiers({ roller: side(), target, test: skill('ath') }, sources), []);
});

test('consume and vsTarget work on any effect', () => {
    const roller = side({
        effects: [
            plain('E3', 'Lucky Charm', [{ who: 'self', mode: 'advantage', tests: 'all', consume: true }]),
            plain('E4', 'Marked Prey', [{ who: 'self', mode: 'advantage', tests: 'attack', vsTarget: true }], { value: { targetUuid: 'Actor.t', targetName: 'Brute' } }),
        ],
    });
    const brute = side({ uuid: 'Actor.t' });
    const mods = collectModifiers({ roller, target: brute, test: melee }, sources);
    assert.deepEqual(keys(mods), ['self:effect:E3:advantage', 'self:effect:E4:advantage']);
    assert.deepEqual(mods.find((m) => m.key === 'effect:E3').consume, { actorUuid: 'Actor.a', effectId: 'E3' });
    assert.equal(mods.find((m) => m.key === 'effect:E4').label, 'Marked Prey (Brute)');
    assert.equal(mods.find((m) => m.key === 'effect:E4').consume, undefined);
    assert.deepEqual(keys(collectModifiers({ roller, target: side({ uuid: 'Actor.o' }), test: melee }, sources)), ['self:effect:E3:advantage']);
});

test('a condition with its own consume rule is used up like any effect', () => {
    const rows = [{ effect: { id: 'cond1', name: 'Empowered' }, conditionId: 'empowered', rules: { schema: 1, rolls: [{ who: 'self', mode: 'advantage', tests: 'all', consume: true }] } }];
    const mods = collectModifiers({ roller: { uuid: 'Actor.a', name: 'A', sources: rollSources(rows, TABLES) }, target: null, test: skill('ath') }, sources);
    assert.deepEqual(mods.map((m) => [m.key, m.label, m.consume?.effectId]), [['empowered', 'Empowered', 'cond1']]);
});

test('two plain effects each count; two instances of a condition count once', () => {
    const rule = [{ who: 'self', mode: 'disadvantage', tests: 'all' }];
    const roller = side({ conditions: ['restrained', 'restrained'], effects: [plain('E5', 'Ache', rule), plain('E6', 'Ache', rule)] });
    assert.deepEqual(keys(collectModifiers({ roller, target: null, test: skill('ath') }, sources)), [
        'self:effect:E5:disadvantage',
        'self:effect:E6:disadvantage',
        'self:restrained:disadvantage',
    ]);
});

test('modeOf gets the source key: a plain effect can be off or remind on its own', () => {
    const roller = side({ conditions: ['restrained'], effects: [plain('E7', 'Hex', [{ who: 'self', mode: 'disadvantage', tests: 'all' }])] });
    const modeOf = (key) => (key.startsWith('effect:') ? 'remind' : 'full');
    const mods = collectModifiers({ roller, target: null, test: skill('ath') }, { modeOf });
    assert.deepEqual(mods.map((m) => [m.key, m.active]).sort(), [['effect:E7', false], ['restrained', true]]);
    assert.deepEqual(collectModifiers({ roller, target: null, test: skill('ath') }, { modeOf: (k) => (k.startsWith('effect:') ? 'off' : 'full') }).length, 1);
});

test('the stance marker resolves to its stance; it wins over the table-only stance source', () => {
    const marker = (rules) => ({ effect: { id: 'M1', name: 'Stance: Flamestance' }, stanceId: 'flamestance', rules });
    const fromTable = defaultRules(SITUATIONAL_BY_ID.flamestance);
    const withMarker = side({ effects: [marker(fromTable)], stance: 'flamestance' });
    const mods = collectModifiers({ roller: withMarker, target: null, test: skill('inm') }, sources);
    assert.deepEqual(keys(mods), ['self:situational:flamestance:advantage'], 'counted once');
    assert.equal(mods[0].label, 'Flamestance');

    const own = side({ effects: [marker({ schema: 1, rolls: [] })], stance: 'flamestance' });
    assert.deepEqual(collectModifiers({ roller: own, target: null, test: skill('inm') }, sources), [], 'the marker\'s own rules win');

    const other = rollSources([{ effect: { id: 'M2', name: 'Stance: Stonestance' }, stanceId: 'stonestance', rules: { schema: 1, rolls: [{ who: 'target', mode: 'disadvantage', tests: 'melee' }] } }], TABLES);
    assert.deepEqual(other.map((s) => [s.key, s.modeKey, s.label]), [['stance:stonestance', 'effect:M2', 'Stance: Stonestance']], 'a stance with no table entry is an effect like any other');
    assert.equal(stanceSource('stonestance', SITUATIONAL_BY_ID), null);

    const stale = side({ effects: [marker(fromTable)], stance: 'stonestance' });
    assert.deepEqual(collectModifiers({ roller: stale, target: null, test: skill('inm') }, sources), [], 'a marker left from another stance');
});

test('rollSources leaves out effects without roll rules', () => {
    const rows = [
        { effect: { id: 'a' }, conditionId: 'slowed', rules: defaultRules(CONDITIONS_BY_ID.slowed) },
        { effect: { id: 'b', name: 'Nothing' }, rules: { schema: 1 } },
    ];
    assert.deepEqual(rollSources(rows, TABLES), []);
});
