import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONDITIONS, CONDITIONS_BY_ID, MECHANICS } from '../data/conditions.js';
import { conditionIdOf, findLinkCycle, isAutomated, resolveLinks, validateTable } from '../scripts/logic/table.js';

const SYSTEM_STATUSES = [
    'afflicted', 'blind', 'burrowing', 'depleted', 'determined', 'diminished', 'disoriented', 'empowered',
    'enhanced', 'exhausted', 'flying', 'focused', 'hidden', 'immobilized', 'invisible', 'prone', 'restrained',
    'slowed', 'stunned', 'surprised', 'unconscious', 'dead',
];

test('the condition table is valid', () => {
    assert.deepEqual(validateTable(CONDITIONS), []);
});

test('the table covers exactly the 22 statuses of cosmere-rpg 3.1.2', () => {
    assert.deepEqual(CONDITIONS.map((c) => c.id).sort(), [...SYSTEM_STATUSES].sort());
});

test('phase 1 automates the conditions the design lists', () => {
    const phase1 = CONDITIONS.filter((c) => isAutomated(c, 1)).map((c) => c.id).sort();
    assert.deepEqual(phase1, ['afflicted', 'enhanced', 'exhausted', 'immobilized', 'prone', 'restrained', 'slowed', 'unconscious']);
});

test('phase 2 adds Stunned and Surprised; the release default is phase 2', () => {
    const phase2 = CONDITIONS.filter((c) => isAutomated(c, 2) && !isAutomated(c, 1)).map((c) => c.id).sort();
    assert.deepEqual(phase2, ['stunned', 'surprised']);
    assert.equal(isAutomated(CONDITIONS_BY_ID.stunned), true);
    assert.equal(isAutomated(CONDITIONS_BY_ID.empowered), false);
});

test('default durations are valid; Surprised ends after its next turn', () => {
    assert.deepEqual(CONDITIONS_BY_ID.surprised.duration, ['endOfNextTurn']);
    const bad = validateTable([{ id: 'x', name: 'X', summary: 's', mechanics: [], links: [], duration: ['soon'] }]);
    assert.ok(bad.some((e) => e.includes('unknown duration kind')), bad.join('\n'));
});

test('out-of-scope and marker conditions are never automated', () => {
    for (const id of ['depleted', 'diminished', 'dead', 'burrowing']) assert.equal(isAutomated(CONDITIONS_BY_ID[id], 99), false);
});

test('links: Unconscious brings Prone, which brings Slowed', () => {
    assert.deepEqual(resolveLinks(CONDITIONS_BY_ID, 'unconscious'), ['prone', 'slowed']);
    assert.deepEqual(resolveLinks(CONDITIONS_BY_ID, 'prone'), ['slowed']);
    assert.deepEqual(resolveLinks(CONDITIONS_BY_ID, 'slowed'), []);
    assert.deepEqual(resolveLinks(CONDITIONS_BY_ID, 'nope'), []);
});

test('validation catches bad entries', () => {
    const base = { name: 'X', summary: 's', mechanics: [], links: [] };
    const errors = validateTable([
        { ...base, id: 'a', links: ['missing'] },
        { ...base, id: 'a' },
        { ...base, id: 'b', mechanics: ['teleport'] },
        { ...base, id: 'c', value: 'colour' },
        { ...base, id: 'd', mechanics: [MECHANICS.ATTRIBUTE_BONUS] },
        { ...base, id: 'e', stackable: true, multiInstance: true },
        { ...base, id: 'f', links: ['f'] },
        { id: 'g', mechanics: [], links: [] },
    ]);
    const joined = errors.join('\n');
    for (const fragment of [
        'unknown condition "missing"',
        'a: duplicate id',
        'unknown mechanic "teleport"',
        'unknown value type "colour"',
        'attributeBonus needs value type',
        'cannot be both',
        'f: links to itself',
        'g: missing name',
        'g: missing summary',
    ]) {
        assert.ok(joined.includes(fragment), `expected "${fragment}" in:\n${joined}`);
    }
});

test('cycle detection', () => {
    const base = { name: 'X', summary: 's', mechanics: [] };
    assert.deepEqual(
        findLinkCycle([
            { ...base, id: 'a', links: ['b'] },
            { ...base, id: 'b', links: ['c'] },
            { ...base, id: 'c', links: ['a'] },
        ]),
        ['a', 'b', 'c', 'a'],
    );
    assert.equal(findLinkCycle([{ ...base, id: 'a', links: ['b'] }, { ...base, id: 'b', links: [] }]), null);
    // Diamond shape is fine.
    assert.equal(
        findLinkCycle([
            { ...base, id: 'a', links: ['b', 'c'] },
            { ...base, id: 'b', links: ['d'] },
            { ...base, id: 'c', links: ['d'] },
            { ...base, id: 'd', links: [] },
        ]),
        null,
    );
});

test('conditionIdOf: exactly one known status', () => {
    assert.equal(conditionIdOf(new Set(['prone']), CONDITIONS_BY_ID), 'prone');
    assert.equal(conditionIdOf(['prone', 'slowed'], CONDITIONS_BY_ID), null);
    assert.equal(conditionIdOf(new Set(['ep-stance']), CONDITIONS_BY_ID), null);
    assert.equal(conditionIdOf(new Set(), CONDITIONS_BY_ID), null);
    assert.equal(conditionIdOf(undefined, CONDITIONS_BY_ID), null);
});

test('summaries are short and in our own words (no long book quotes)', () => {
    for (const entry of CONDITIONS) assert.ok(entry.summary.length <= 200, `${entry.id} summary is long`);
});
