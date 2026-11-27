/**
 * Durations through the Foundry glue, driven by a fake combat whose turn pointer moves the way
 * Advanced Encounters moves it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeActor, FakeCombat, FakeItem, flush, Hooks, installFakeFoundry } from './fake-foundry.js';

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

test('Afflicted: each instance deals its damage at the end of each of its turns; remind mode only reminds', async () => {
    const { kal, shallan, combat } = setup();
    await api.apply(kal, 'afflicted', { value: { type: 'keen', amount: 3 } });
    await api.apply(kal, 'afflicted', { value: { type: 'impact', amount: 1 } });
    await flush();
    await combat.start();
    await combat.startTurn(kal);
    assert.equal(kal.damageCalls, undefined, 'not at the start of its turn');
    await combat.endTurn();
    assert.deepEqual(kal.damageCalls, [[{ amount: 3, type: 'keen' }], [{ amount: 1, type: 'impact' }]], 'one by one');
    await combat.startTurn(shallan);
    await combat.endTurn();
    assert.equal(kal.damageCalls.length, 2, "not on someone else's turn");

    env.settings.set('condition.afflicted', 'remind');
    try {
        const before = env.chat.length;
        await combat.nextRound();
        await combat.startTurn(kal);
        await combat.endTurn();
        assert.equal(kal.damageCalls.length, 2, 'remind: no damage');
        assert.ok(env.chat.slice(before).some((m) => m.content.includes('deals its damage now')));
    } finally {
        env.settings.set('condition.afflicted', 'full');
    }
});

test('Surprised: its fast turn becomes slow, also when set back to fast; remind mode and bosses only remind', async () => {
    const { kal, combat } = setup();
    game.combats = [combat];
    try {
        const combatant = combat.combatantOf(kal);
        assert.equal(combatant.turnSpeed, 'fast');
        await api.apply(kal, 'surprised');
        await flush();
        assert.equal(combatant.turnSpeed, 'slow');
        await combatant.setFlag('cosmere-rpg', 'turnSpeed', 'fast');
        await flush();
        assert.equal(combatant.turnSpeed, 'slow', 'switched back by the GM');

        env.settings.set('condition.surprised', 'remind');
        const shallan = new FakeActor({ name: 'Shallan' });
        const other = new FakeCombat([{ actor: shallan, fast: true }]);
        game.combats = [other];
        const before = env.chat.length;
        await api.apply(shallan, 'surprised');
        await flush();
        assert.equal(other.combatantOf(shallan).turnSpeed, 'fast', 'remind: unchanged');
        assert.ok(env.chat.slice(before).some((m) => m.content.includes('cannot take a fast turn')));

        env.settings.set('condition.surprised', 'full');
        const boss = new FakeActor({ name: 'Boss', type: 'adversary', hasPlayerOwner: false });
        const bossFight = new FakeCombat([{ actor: boss, isBoss: true }]);
        game.combats = [bossFight];
        const beforeBoss = env.chat.length;
        await api.apply(boss, 'surprised');
        await flush();
        assert.equal(bossFight.combatantOf(boss).turnSpeed, 'slow');
        assert.ok(env.chat.slice(beforeBoss).some((m) => /Skip its fast turn/.test(m.content)), 'boss: a reminder');
    } finally {
        env.settings.set('condition.surprised', 'full');
        game.combats = undefined;
    }
});

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

test('a long rest leaves Exhausted to Cosmere Automated Actions when its decrementExhaustion is on', async () => {
    const { modules, settings } = game;
    const other = { useAutomations: true, decrementExhaustion: true };
    game.modules = { get: (id) => (id === 'cosmere-automated-actions' ? { active: true } : modules.get(id)) };
    game.settings = { ...settings, get: (scope, key) => (scope === 'cosmere-automated-actions' ? other[key] : settings.get(scope, key)) };
    try {
        const rock = new FakeActor({ name: 'Rock' });
        await api.apply(rock, 'exhausted', { stacks: 2 });
        await flush();
        Hooks.callAll('cosmere-rpg.rest', rock, 'long');
        await flush();
        assert.equal(rock.effects.contents[0].system.stacks, 2, 'the other module takes the stack, not us');
        other.decrementExhaustion = false;
        Hooks.callAll('cosmere-rpg.rest', rock, 'long');
        await flush();
        assert.equal(rock.effects.contents[0].system.stacks, 1, 'with it off, we do');
    } finally {
        game.modules = modules;
        game.settings = settings;
    }
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

/* --- Held conditions (as in PF2e): a source keeps what it brought --- */

const injuryOn = (name) => {
    const injury = new FakeItem({ id: randomId(), name: 'Vicious Injury', type: 'injury', documentName: 'Item' });
    return { actor: new FakeActor({ name, items: [injury] }), injury };
};
let idCounter = 0;
function randomId() {
    idCounter += 1;
    return `injury${String(idCounter).padStart(10, '0')}`;
}
async function healInjury(actor, injury) {
    actor.items.delete(injury.id);
    Hooks.callAll('deleteItem', injury, {}, game.user.id);
    await flush();
}
const exhausted = (actor) => actor.effects.find((e) => e.statuses.has('exhausted'));

test('Slowed from Prone cannot be removed by hand while Prone stays; it goes with Prone', async () => {
    const lift = new FakeActor({ name: 'Lift' });
    await hudToggle(lift, 'prone');
    const before = env.warnings.length;
    await hudToggle(lift, 'slowed');
    assert.ok(has(lift, 'slowed'), 'still Slowed');
    assert.match(env.warnings.at(-1), /Slowed comes from Prone/);
    assert.equal(env.warnings.length, before + 1);
    assert.deepEqual(await api.remove(lift, 'slowed'), [], 'the API refuses too');
    await hudToggle(lift, 'prone');
    assert.deepEqual(statuses(lift), []);
});

test('Slowed by hand and from Prone: removing it by hand drops only the hand-applied part', async () => {
    const lopen = new FakeActor({ name: 'Lopen' });
    await hudToggle(lopen, 'slowed');
    await hudToggle(lopen, 'prone');
    await hudToggle(lopen, 'slowed');
    const slowed = lopen.effects.find((e) => e.statuses.has('slowed'));
    assert.deepEqual(slowed.getFlag('ep-cosmere-automations', 'sources').map((s) => s.label), ['Prone']);
    await hudToggle(lopen, 'prone');
    assert.deepEqual(statuses(lopen), [], 'nothing holds it any more');
});

test('remove with force takes a held condition off anyway', async () => {
    const rlain = new FakeActor({ name: 'Rlain' });
    await hudToggle(rlain, 'prone');
    assert.equal((await api.remove(rlain, 'slowed', { force: true })).length, 1);
    assert.ok(!has(rlain, 'slowed'));
});

test("an injury's Exhausted survives long rests and goes when the injury heals", async () => {
    const { actor: arlo, injury } = injuryOn('Arlo');
    await hudToggle(arlo, 'exhausted'); // set by hand before the module knew about the injury
    await api.tie(arlo, 'exhausted', injury);
    assert.equal(exhausted(arlo).system.stacks ?? 1, 1, 'tying adds no stack');
    assert.deepEqual(exhausted(arlo).getFlag('ep-cosmere-automations', 'sources'), [{ key: `item:${injury.id}`, label: 'Vicious Injury', stacks: 1 }]);

    Hooks.callAll('cosmere-rpg.rest', arlo, 'long');
    await flush();
    assert.ok(exhausted(arlo), 'a long rest leaves it');
    assert.match(env.chat.at(-1).content, /stays .*Exhausted.* after the long rest \(from Vicious Injury\)/);

    await hudToggle(arlo, 'exhausted');
    assert.ok(exhausted(arlo), 'not removable by hand');

    await api.apply(arlo, 'exhausted'); // a day without food: one more, by hand
    assert.equal(exhausted(arlo).system.stacks, 2);
    await exhausted(arlo).update({ 'system.stacks': 0 });
    assert.equal(exhausted(arlo).system.stacks, 2, 'the HUD cannot take it below what the injury holds');
    Hooks.callAll('cosmere-rpg.rest', arlo, 'long');
    await flush();
    assert.equal(exhausted(arlo).system.stacks, 1, 'the long rest takes the hand-applied stack');
    assert.deepEqual(exhausted(arlo).getFlag('ep-cosmere-automations', 'sources').map((s) => s.key), [`item:${injury.id}`]);

    await healInjury(arlo, injury);
    assert.ok(!exhausted(arlo), 'gone with the injury');
});

test("a source's stacks go with it; the hand-applied ones stay", async () => {
    const { actor: taren, injury } = injuryOn('Taren');
    await api.apply(taren, 'exhausted', { source: injury, stacks: 2 });
    await api.apply(taren, 'exhausted');
    assert.equal(exhausted(taren).system.stacks, 3);
    await exhausted(taren).update({ 'system.stacks': 2 });
    assert.equal(exhausted(taren).system.stacks, 2, 'a free stack can go by hand');
    await healInjury(taren, injury);
    assert.ok(!exhausted(taren), 'no free stack was left');

    const { actor: nalara, injury: hers } = injuryOn('Nalara');
    await api.apply(nalara, 'exhausted', { source: hers });
    await api.apply(nalara, 'exhausted', { stacks: 2 });
    await healInjury(nalara, hers);
    assert.equal(exhausted(nalara).system.stacks, 2);
});
