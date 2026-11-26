/**
 * Durations through the Foundry glue, driven by a fake combat whose turn pointer moves the way
 * Advanced Encounters moves it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeActor, FakeCombat, flush, Hooks, installFakeFoundry } from './fake-foundry.js';

const CONDITION_IDS = ['afflicted', 'enhanced', 'exhausted', 'immobilized', 'prone', 'restrained', 'slowed', 'unconscious', 'stunned', 'surprised'];
const env = installFakeFoundry({
    settings: {
        ...Object.fromEntries(CONDITION_IDS.map((id) => [`condition.${id}`, 'full'])),
        durations: 'full',
        stances: 'full',
        sceneRecharge: 'full',
    },
});
await import('../scripts/main.js');
Hooks.callAll('init');
const api = env.module.api;

const statuses = (actor) => actor.effects.contents.map((e) => [...e.statuses][0]).sort();
const has = (actor, id) => actor.effects.some((e) => e.statuses.has(id));

async function hudToggle(actor, id) {
    const existing = actor.effects.find((e) => e.statuses.has(id));
    if (existing) await actor.deleteEmbeddedDocuments('ActiveEffect', [existing.id]);
    else {
        const effect = await CONFIG.ActiveEffect.documentClass.fromStatusEffect(id);
        await actor.createEmbeddedDocuments('ActiveEffect', [effect.toObject()], { keepId: true });
    }
    await flush();
}

function setup() {
    const kal = new FakeActor({ name: 'Kal' });
    const shallan = new FakeActor({ name: 'Shallan' });
    const brute = new FakeActor({ name: 'Brute', type: 'adversary', hasPlayerOwner: false });
    const combat = new FakeCombat([
        { actor: kal, fast: true },
        { actor: shallan },
        { actor: brute },
    ]);
    return { kal, shallan, brute, combat };
}

test('Stunned until the end of its next turn, applied during its own turn', async () => {
    const { kal, shallan, combat } = setup();
    await combat.start();
    await combat.startTurn(kal);
    await api.apply(kal, 'stunned', { duration: 'endOfNextTurn' });
    await flush();
    assert.match(api.list(kal)[0].lasts, /end of its next turn/);

    await combat.endTurn(); // the turn it was applied in doesn't count
    assert.ok(has(kal, 'stunned'));
    await combat.startTurn(shallan);
    await combat.endTurn();
    await combat.nextRound();
    await combat.startTurn(kal);
    assert.ok(has(kal, 'stunned'));
    await combat.endTurn();
    assert.equal(has(kal, 'stunned'), false);
    assert.ok(env.chat.some((m) => m.content.includes('its duration ended')));
});

test('Surprised gets its default duration and ends after its first turn', async () => {
    const { brute, kal, combat } = setup();
    await combat.start();
    await api.apply(brute, 'surprised');
    await flush();
    await combat.startTurn(kal);
    await combat.endTurn();
    assert.ok(has(brute, 'surprised'));
    await combat.startTurn(brute);
    await combat.endTurn();
    assert.equal(has(brute, 'surprised'), false);
});

test('from the token in combat, the dialog asks for a duration; "same phase next round" ends at that phase', async () => {
    const { kal, shallan, brute, combat } = setup();
    await combat.start();
    await combat.startTurn(shallan); // slow PC phase
    globalThis.__dialogAnswer = { duration: 'phaseNextRound' };
    const before = globalThis.__dialogCount ?? 0;
    try {
        await hudToggle(brute, 'restrained');
    } finally {
        delete globalThis.__dialogAnswer;
    }
    assert.equal(globalThis.__dialogCount, before + 1);
    assert.match(api.list(brute)[0].lasts, /slow PC phase next round/);

    await combat.endTurn();
    await combat.nextRound();
    await combat.startTurn(kal); // fast PC: too early
    await combat.endTurn();
    assert.ok(has(brute, 'restrained'));
    await combat.startTurn(shallan); // slow PC: ends
    assert.equal(has(brute, 'restrained'), false);
});

test('links: the child has no duration of its own and ends with its parent', async () => {
    const { kal, combat } = setup();
    await combat.start();
    await api.apply(kal, 'prone', { duration: 'startOfNextTurn' });
    await flush();
    assert.deepEqual(statuses(kal), ['prone', 'slowed']);
    await combat.startTurn(kal);
    assert.deepEqual(statuses(kal), []);
});

test('ending the encounter ends combat durations and the scene: stances end, per-scene uses recharge', async () => {
    const stonestance = { id: 'T1', type: 'talent', name: 'Stonestance', img: 's.svg', system: { id: 'stonestance', modality: 'stance' } };
    let recharged = null;
    const recover = {
        id: 'I1',
        type: 'action',
        name: 'Recover',
        system: { resources: { uses: { value: 0, max: 1, recharge: 'per_scene' } } },
        recharge: async (keys) => {
            recharged = keys;
        },
    };
    const adolin = new FakeActor({ name: 'Adolin', items: [stonestance, recover] });
    const combat = new FakeCombat([{ actor: adolin }]);
    await combat.start();
    await adolin.setMode('stance', 'stonestance');
    await flush();
    assert.ok(has(adolin, 'ep-stance'));
    await api.apply(adolin, 'stunned', { duration: 'endOfNextTurn' });
    await api.apply(adolin, 'immobilized', { duration: 'endOfScene' });
    await api.apply(adolin, 'slowed', { duration: 'longRest' });
    await flush();

    await combat.end();
    assert.deepEqual(statuses(adolin), ['slowed']);
    assert.equal(adolin.getFlag('cosmere-rpg', 'mode.stance'), null);
    assert.ok(!has(adolin, 'ep-stance'), 'the stance marker is gone');
    assert.deepEqual(recharged, ['uses']);
});

test('a long rest ends "until a long rest" effects and removes one Exhausted stack', async () => {
    const teft = new FakeActor({ name: 'Teft' });
    await api.apply(teft, 'exhausted', { stacks: 2 });
    await api.apply(teft, 'slowed', { duration: 'longRest' });
    await flush();
    Hooks.callAll('cosmere-rpg.rest', teft, 'long');
    await flush();
    assert.deepEqual(statuses(teft), ['exhausted']);
    assert.equal(teft.effects.contents[0].system.stacks, 1);
    Hooks.callAll('cosmere-rpg.rest', teft, 'short');
    await flush();
    assert.equal(teft.effects.contents[0].system.stacks, 1, 'a short rest changes nothing');
    Hooks.callAll('cosmere-rpg.rest', teft, 'long');
    await flush();
    assert.deepEqual(statuses(teft), []);
});

test('days pass; until used', async () => {
    const lift = new FakeActor({ name: 'Lift' });
    await api.apply(lift, 'slowed', { duration: { kinds: 'days', days: 2 } });
    await api.apply(lift, 'immobilized', { duration: ['untilUsed', 'endOfScene'] });
    await flush();
    await api.advanceDays(1, { actors: [lift] });
    assert.ok(has(lift, 'slowed'));
    assert.match(api.list(lift).find((c) => c.id === 'slowed').lasts, /1 more day/);
    await api.advanceDays(1, { actors: [lift] });
    assert.equal(has(lift, 'slowed'), false);
    await api.use(lift.effects.find((e) => e.statuses.has('immobilized')));
    assert.deepEqual(statuses(lift), []);
});

test('remind mode: says it ends, keeps the effect, and says it once', async () => {
    env.settings.set('durations', 'remind');
    try {
        const { kal, combat } = setup();
        await combat.start();
        await api.apply(kal, 'stunned', { duration: 'startOfNextTurn' });
        await flush();
        const before = env.chat.length;
        await combat.startTurn(kal);
        await combat.endTurn();
        await combat.nextRound();
        await combat.startTurn(kal);
        assert.ok(has(kal, 'stunned'));
        const lines = env.chat.slice(before).filter((m) => m.content.includes('ends now'));
        assert.equal(lines.length, 1);
    } finally {
        env.settings.set('durations', 'full');
    }
});

test('durations off: nothing ends and the dialog does not ask', async () => {
    env.settings.set('durations', 'off');
    try {
        const { kal, combat } = setup();
        await combat.start();
        const before = globalThis.__dialogCount ?? 0;
        await hudToggle(kal, 'stunned');
        assert.equal(globalThis.__dialogCount ?? 0, before);
        await api.apply(kal, 'slowed', { duration: 'startOfNextTurn' });
        await flush();
        await combat.startTurn(kal);
        assert.deepEqual(statuses(kal), ['slowed', 'stunned']);
    } finally {
        env.settings.set('durations', 'full');
    }
});

test('a bad duration is refused', async () => {
    const actor = new FakeActor({ name: 'Rlain' });
    await assert.rejects(api.apply(actor, 'slowed', { duration: 'soonish' }), /unknown duration kind/);
});
