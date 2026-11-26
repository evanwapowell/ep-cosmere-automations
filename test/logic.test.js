import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONDITIONS_BY_ID } from '../data/conditions.js';
import { adjustedRate, planAdjustments, rateBonusDelta } from '../scripts/logic/mechanics.js';
import {
    addSource,
    describeSources,
    effectKey,
    isSourceGone,
    itemKey,
    MANUAL,
    planSourceRemoval,
    readSources,
    removeSource,
} from '../scripts/logic/sources.js';
import { findModalityTalent, isEndStance, normalizeId, relationshipList, talentMode } from '../scripts/logic/stances.js';
import { EFFECT_MODES, formatValue, instanceId, normalizeValue, valueEffectData } from '../scripts/logic/values.js';

const full = () => true;

/* --- mechanics --- */

test('no adjustments without automated conditions', () => {
    const plan = planAdjustments([{ id: 'stunned' }, { id: 'prone' }], CONDITIONS_BY_ID, full);
    assert.deepEqual(plan, { noMovement: [], halfMovement: [], skillPenalty: 0, penaltySources: [] });
});

test('Slowed halves movement, rounding down', () => {
    const plan = planAdjustments([{ id: 'slowed' }], CONDITIONS_BY_ID, full);
    assert.equal(adjustedRate(30, plan), 15);
    assert.equal(adjustedRate(25, plan), 12);
    assert.equal(rateBonusDelta(25, plan), -13);
    assert.equal(adjustedRate(0, plan), 0);
});

test('two halving conditions halve once; movement 0 wins over halving', () => {
    const twice = planAdjustments([{ id: 'slowed' }, { id: 'slowed' }], CONDITIONS_BY_ID, full);
    assert.equal(adjustedRate(40, twice), 20);
    const zero = planAdjustments([{ id: 'slowed' }, { id: 'restrained' }], CONDITIONS_BY_ID, full);
    assert.equal(adjustedRate(40, zero), 0);
    assert.equal(rateBonusDelta(40, zero), -40);
});

test('Immobilized, Restrained and Unconscious set movement to 0', () => {
    for (const id of ['immobilized', 'restrained', 'unconscious']) {
        const plan = planAdjustments([{ id }], CONDITIONS_BY_ID, full);
        assert.equal(adjustedRate(30, plan), 0, id);
    }
});

test('Exhausted: −1 per stack, several effects add up', () => {
    assert.equal(planAdjustments([{ id: 'exhausted', stacks: 3 }], CONDITIONS_BY_ID, full).skillPenalty, 3);
    assert.equal(planAdjustments([{ id: 'exhausted' }], CONDITIONS_BY_ID, full).skillPenalty, 1);
    assert.equal(planAdjustments([{ id: 'exhausted', stacks: 0 }], CONDITIONS_BY_ID, full).skillPenalty, 1);
    assert.equal(
        planAdjustments([{ id: 'exhausted', stacks: 2 }, { id: 'exhausted', stacks: 1 }], CONDITIONS_BY_ID, full).skillPenalty,
        3,
    );
});

test('conditions not in full mode change nothing', () => {
    const plan = planAdjustments(
        [{ id: 'slowed' }, { id: 'exhausted', stacks: 2 }, { id: 'immobilized' }],
        CONDITIONS_BY_ID,
        (id) => id === 'slowed',
    );
    assert.equal(plan.skillPenalty, 0);
    assert.deepEqual(plan.noMovement, []);
    assert.deepEqual(plan.halfMovement, ['slowed']);
});

test('non-numeric rates are left alone', () => {
    const plan = planAdjustments([{ id: 'slowed' }], CONDITIONS_BY_ID, full);
    assert.ok(Number.isNaN(adjustedRate(NaN, plan)));
    assert.equal(rateBonusDelta(NaN, plan), 0);
});

/* --- sources --- */

test('readSources: missing or malformed data means manual', () => {
    assert.deepEqual(readSources(undefined), [MANUAL]);
    assert.deepEqual(readSources([]), [MANUAL]);
    assert.deepEqual(readSources([{ nope: 1 }]), [MANUAL]);
    assert.deepEqual(readSources([{ key: 'effect:x', label: 'Prone' }]), [{ key: 'effect:x', label: 'Prone' }]);
});

test('add and remove sources', () => {
    const prone = { key: effectKey('p'), label: 'Prone' };
    let sources = addSource([], prone);
    sources = addSource(sources, prone);
    assert.equal(sources.length, 1);
    sources = addSource(sources, { ...MANUAL });
    assert.equal(describeSources(sources), 'Prone');
    const r1 = removeSource(sources, prone.key);
    assert.deepEqual(r1, { sources: [MANUAL], changed: true, orphaned: false });
    const r2 = removeSource(r1.sources, MANUAL.key);
    assert.equal(r2.orphaned, true);
    assert.equal(removeSource([], 'x').changed, false);
});

test('isSourceGone', () => {
    const present = { effectIds: new Set(['a']), itemIds: new Set(['i']) };
    assert.equal(isSourceGone(effectKey('a'), present), false);
    assert.equal(isSourceGone(effectKey('b'), present), true);
    assert.equal(isSourceGone(itemKey('i'), present), false);
    assert.equal(isSourceGone(itemKey('j'), present), true);
    assert.equal(isSourceGone('manual', present), false);
    assert.equal(isSourceGone('claude', present), false);
});

test('removing Prone ends the Slowed it brought, but not a Slowed someone else also applied', () => {
    const effects = [
        { id: 'slowed1', sources: [{ key: effectKey('prone'), label: 'Prone' }] },
        { id: 'slowed2', sources: [{ key: effectKey('prone'), label: 'Prone' }, { key: 'manual', label: 'manual' }] },
        { id: 'handmade' }, // not ours
        { id: 'other', sources: [{ key: effectKey('stays'), label: 'X' }] },
    ];
    const present = { effectIds: new Set(['slowed1', 'slowed2', 'handmade', 'other', 'stays']), itemIds: new Set() };
    const plan = planSourceRemoval(effects, (key) => isSourceGone(key, present));
    assert.deepEqual(plan, [
        { id: 'slowed1', action: 'delete', sources: [] },
        { id: 'slowed2', action: 'update', sources: [{ key: 'manual', label: 'manual' }] },
    ]);
});

test('source removal converges when several parents go at once', () => {
    // Slowed held by Prone and by an injury; both deleted in one batch.
    const effects = [
        {
            id: 'slowed',
            sources: [
                { key: effectKey('prone'), label: 'Prone' },
                { key: itemKey('inj'), label: 'Shallow Injury' },
            ],
        },
    ];
    const present = { effectIds: new Set(['slowed']), itemIds: new Set() };
    const plan = planSourceRemoval(effects, (key) => isSourceGone(key, present));
    assert.deepEqual(plan, [{ id: 'slowed', action: 'delete', sources: [] }]);
    // Running it again on the same state gives the same answer.
    assert.deepEqual(planSourceRemoval(effects, (key) => isSourceGone(key, present)), plan);
});

/* --- values --- */

const choices = { damageTypes: ['keen', 'impact', 'energy'], attributes: ['str', 'spd', 'int'] };

test('Afflicted values', () => {
    const entry = CONDITIONS_BY_ID.afflicted;
    assert.deepEqual(normalizeValue(entry, { type: 'keen', amount: '3' }, choices), { ok: true, value: { type: 'keen', amount: 3 } });
    assert.equal(normalizeValue(entry, { type: 'keen', amount: 0 }, choices).ok, false);
    assert.equal(normalizeValue(entry, { type: 'keen', amount: 1.5 }, choices).ok, false);
    assert.equal(normalizeValue(entry, { type: 'cold', amount: 2 }, choices).ok, false);
    assert.equal(normalizeValue(entry, { amount: 2 }, choices).ok, false);
    assert.equal(normalizeValue(entry, null, choices).ok, false);
    assert.equal(formatValue(entry, { type: 'keen', amount: 3 }, { damageTypes: { keen: 'Keen' } }), '3 Keen');
});

test('Enhanced values and the change they write', () => {
    const entry = CONDITIONS_BY_ID.enhanced;
    const { value } = normalizeValue(entry, { attribute: 'str', amount: 1 }, choices);
    assert.deepEqual(value, { attribute: 'str', amount: 1 });
    assert.equal(normalizeValue(entry, { attribute: 'str', amount: 0 }, choices).ok, false);
    assert.equal(normalizeValue(entry, { attribute: 'xyz', amount: 1 }, choices).ok, false);

    const labels = { attributes: { str: 'Strength' } };
    const data = valueEffectData(entry, value, { baseName: 'Enhanced', full: true, labels, flagScope: 'm' });
    assert.equal(data.name, 'Enhanced [Strength +1]');
    assert.deepEqual(data.changes, [{ key: 'system.attributes.str.bonus', mode: EFFECT_MODES.ADD, value: '1' }]);
    assert.deepEqual(data.flags, { m: { value } });

    const remind = valueEffectData(entry, value, { baseName: 'Enhanced', full: false, labels, flagScope: 'm' });
    assert.equal(remind.changes, undefined, 'remind mode writes no changes');
    assert.equal(formatValue(entry, { attribute: 'spd', amount: -2 }), 'spd −2');
});

test('conditions without a value', () => {
    const entry = CONDITIONS_BY_ID.prone;
    assert.deepEqual(normalizeValue(entry, { anything: 1 }), { ok: true, value: null });
    assert.equal(valueEffectData(entry, null, { baseName: 'Prone', full: true, flagScope: 'm' }).name, 'Prone');
});

test('instance ids: 16 characters, start with cond<status>, differ from the system id', () => {
    let n = 0;
    const random = () => `abcdefghijklmnop${n++}`;
    const id = instanceId('afflicted', random);
    assert.equal(id.length, 16);
    assert.ok(id.startsWith('condafflicted'));
    assert.notEqual(id, 'condafflicted000');
    // A random value that would recreate the system id is retried.
    const zeros = ['0000000000000000', 'zzzzzzzzzzzzzzzz'];
    assert.equal(instanceId('afflicted', () => zeros.shift()), 'condafflictedzzz');
});

/* --- stances --- */

const stonestance = { id: 'T1', uuid: 'Actor.A.Item.T1', type: 'talent', name: 'Stonestance', system: { id: 'stonestance', modality: 'stance' } };
const vinestance = { id: 'T2', uuid: 'Actor.A.Item.T2', type: 'talent', name: 'Vinestance', system: { id: 'vinestance', modality: 'stance' } };
const plainTalent = { id: 'T3', uuid: 'Actor.A.Item.T3', type: 'talent', system: { id: 'stone-stance' } };
const items = [plainTalent, stonestance, vinestance];

test('normalizeId', () => {
    assert.equal(normalizeId('stone-stance'), 'stonestance');
    assert.equal(normalizeId('Stone Stance'), 'stonestance');
    assert.equal(normalizeId(undefined), '');
});

test('the stance talent is found through the action relationship first', () => {
    const action = {
        system: { id: 'something-else', relationships: [{ type: 'parent', itemType: 'talent', uuid: 'Actor.A.Item.T2' }] },
    };
    assert.equal(findModalityTalent(action, items), vinestance);
});

test('relationships stored as a collection or object are read too', () => {
    const rel = { type: 'parent', uuid: 'Actor.A.Item.T1' };
    assert.deepEqual(relationshipList(new Map([['r', rel]]).values()), [rel]);
    assert.deepEqual(relationshipList({ contents: [rel] }), [rel]);
    assert.deepEqual(relationshipList({ r: rel }), [rel]);
    assert.deepEqual(relationshipList(null), []);
    // A relationship uuid that points at a compendium copy still matches by item id at the end.
    assert.equal(findModalityTalent({ system: { relationships: { r: { type: 'parent', uuid: 'Scene.S.Token.K.Actor.A.Item.T1' } } } }, items), stonestance);
});

test('without a relationship, the action id is matched to the talent id', () => {
    assert.equal(findModalityTalent({ system: { id: 'stone-stance' } }, items), stonestance);
    assert.equal(findModalityTalent({ system: { id: 'recover' } }, items), null);
    assert.equal(findModalityTalent({ system: {} }, items), null);
});

test('items with their own modality are left to the system', () => {
    assert.equal(findModalityTalent({ system: { id: 'stonestance', modality: 'stance' } }, items), null);
});

test('talentMode: only a talent with a modality and an id switches a mode', () => {
    assert.deepEqual(talentMode({ type: 'talent', system: { id: 'stonestance', modality: 'stance' } }), { modality: 'stance', id: 'stonestance' });
    assert.equal(talentMode({ type: 'talent', system: { id: 'tough' } }), null);
    assert.equal(talentMode({ type: 'action', system: { id: 'end-stance', modality: 'stance' } }), null, 'actions are the system\'s');
    assert.equal(talentMode({ type: 'talent', system: { modality: 'stance' } }), null);
    assert.equal(talentMode(null), null);
});

test('isEndStance', () => {
    assert.equal(isEndStance('end-stance'), true);
    assert.equal(isEndStance('endstance'), true);
    assert.equal(isEndStance('stonestance'), false);
    assert.equal(isEndStance(undefined), false);
});
