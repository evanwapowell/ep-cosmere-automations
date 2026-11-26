/**
 * Smoke test of the Foundry glue against a fake Foundry (see fake-foundry.js).
 * Proves the wiring; the real Foundry still needs a live test on a `zz` scene.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeActor, flush, Hooks, installFakeFoundry } from './fake-foundry.js';

const FULL = Object.fromEntries(
    ['afflicted', 'enhanced', 'exhausted', 'immobilized', 'prone', 'restrained', 'slowed', 'unconscious'].map((id) => [
        `condition.${id}`,
        'full',
    ]),
);
const env = installFakeFoundry({ settings: { ...FULL, stances: 'full' } });
await import('../scripts/main.js');
Hooks.callAll('init');
const api = env.module.api;

/** Toggle a status the way the token HUD does: the system's status data, kept id. */
async function hudToggle(actor, id) {
    const existing = actor.effects.find((e) => e.statuses.has(id));
    if (existing) await actor.deleteEmbeddedDocuments('ActiveEffect', [existing.id]);
    else {
        const effect = await CONFIG.ActiveEffect.documentClass.fromStatusEffect(id);
        await actor.createEmbeddedDocuments('ActiveEffect', [effect.toObject()], { keepId: true });
    }
    await flush();
}

const statuses = (actor) => actor.effects.contents.map((e) => [...e.statuses][0]).sort();

test('the module loads, registers its settings and exposes the API', () => {
    assert.ok(api, 'api missing');
    for (const fn of ['apply', 'remove', 'list', 'endStance']) assert.equal(typeof api[fn], 'function');
    assert.equal(env.settings.get('condition.prone'), 'full');
    assert.equal(env.settings.has('condition.stunned'), false, 'later-phase conditions have no setting yet');
});

test('HUD Prone brings Slowed; Slowed halves walking speed; removing Prone removes Slowed', async () => {
    const actor = new FakeActor({ name: 'Kal', speed: 3 }); // rate 30
    assert.equal(actor.system.movement.walk.rate.value, 30);

    await hudToggle(actor, 'prone');
    assert.deepEqual(statuses(actor), ['prone', 'slowed']);
    assert.equal(actor.system.movement.walk.rate.value, 15);
    const slowed = actor.effects.find((e) => e.statuses.has('slowed'));
    assert.deepEqual(slowed.getFlag('ep-cosmere-automations', 'sources').map((s) => s.label), ['Prone']);

    await hudToggle(actor, 'prone');
    assert.deepEqual(statuses(actor), []);
    assert.equal(actor.system.movement.walk.rate.value, 30);
    assert.ok(env.chat.some((m) => m.content.includes('is no longer') && m.content.includes('Prone ended')));
});

test('a Slowed applied by hand survives the end of Prone', async () => {
    const actor = new FakeActor({ name: 'Shallan' });
    await hudToggle(actor, 'slowed');
    await hudToggle(actor, 'prone');
    const slowed = actor.effects.find((e) => e.statuses.has('slowed'));
    assert.deepEqual(slowed.getFlag('ep-cosmere-automations', 'sources').map((s) => s.key)[0], 'manual');
    await hudToggle(actor, 'prone');
    assert.deepEqual(statuses(actor), ['slowed']);
});

test('Unconscious chains to Prone and Slowed and unwinds the same way; movement is 0', async () => {
    const actor = new FakeActor({ name: 'Adolin' });
    await hudToggle(actor, 'unconscious');
    assert.deepEqual(statuses(actor), ['prone', 'slowed', 'unconscious']);
    assert.equal(actor.system.movement.walk.rate.value, 0);
    assert.equal(actor.system.movement.fly.rate.value, 0);
    await hudToggle(actor, 'unconscious');
    assert.deepEqual(statuses(actor), []);
});

test('deleting a parent and its child in one batch does not fail', async () => {
    const actor = new FakeActor({ name: 'Renarin' });
    await hudToggle(actor, 'prone');
    const ids = actor.effects.contents.map((e) => e.id);
    await actor.deleteEmbeddedDocuments('ActiveEffect', ids);
    await flush();
    assert.deepEqual(statuses(actor), []);
});

test('Exhausted: −1 per stack on every skill', async () => {
    const actor = new FakeActor({ name: 'Teft' });
    await api.apply(actor, 'exhausted', { stacks: 2 });
    await flush();
    assert.equal(actor.system.skills.ath.mod.value, 0);
    await api.apply(actor, 'exhausted');
    await flush();
    assert.equal(actor.effects.find((e) => e.statuses.has('exhausted')).system.stacks, 3);
    assert.equal(actor.system.skills.per.mod.value, -1);
});

test('remind mode changes nothing and posts the rule', async () => {
    env.settings.set('condition.slowed', 'remind');
    try {
        const actor = new FakeActor({ name: 'Lopen', speed: 3 });
        const before = env.chat.length;
        await hudToggle(actor, 'slowed');
        assert.equal(actor.system.movement.walk.rate.value, 30);
        const line = env.chat.slice(before).map((m) => m.content).join('\n');
        assert.ok(line.includes('halved'), line);
    } finally {
        env.settings.set('condition.slowed', 'full');
    }
});

test('Enhanced through the API: named with its value, raises the attribute bonus', async () => {
    const actor = new FakeActor({ name: 'Sigzil', speed: 4 }); // 30 ft; Speed 5 → 40 ft
    const effect = await api.apply(actor, 'enhanced', { value: { attribute: 'spd', amount: 1 } });
    await flush();
    assert.equal(effect.name, 'Enhanced [Speed +1]');
    assert.equal(actor.system.movement.walk.rate.value, 40);
    await assert.rejects(api.apply(actor, 'enhanced', { value: { attribute: 'luck', amount: 1 } }), /unknown attribute/);
});

test('Afflicted twice: two instances, each with its own value, both listed as conditions', async () => {
    const actor = new FakeActor({ name: 'Moash' });
    await api.apply(actor, 'afflicted', { value: { type: 'keen', amount: 3 } });
    await api.apply(actor, 'afflicted', { value: { type: 'impact', amount: 1 } });
    await flush();
    const list = api.list(actor).filter((c) => c.id === 'afflicted');
    assert.deepEqual(list.map((c) => c.name).sort(), ['Afflicted [1 Impact]', 'Afflicted [3 Keen]']);
    for (const c of list) assert.ok(c.effectId.startsWith('condafflicted') && c.effectId.length === 16, c.effectId);
    await api.remove(actor, 'afflicted');
    await flush();
    assert.deepEqual(statuses(actor), []);
});

test('Afflicted from the HUD asks for its value', async () => {
    const actor = new FakeActor({ name: 'Rock' });
    globalThis.__dialogAnswer = { type: 'keen', amount: 2 };
    try {
        await hudToggle(actor, 'afflicted');
    } finally {
        delete globalThis.__dialogAnswer;
    }
    assert.equal(actor.effects.contents[0].name, 'Afflicted [2 Keen]');
});

test('an item source ends the condition when the item is deleted', async () => {
    const injury = { id: 'inj1', name: 'Shallow Injury', type: 'injury', documentName: 'Item', system: {} };
    const actor = new FakeActor({ name: 'Dalinar', items: [injury] });
    await api.apply(actor, 'slowed', { source: injury });
    await flush();
    assert.equal(api.list(actor)[0].from, 'Shallow Injury');
    actor.items.delete(injury.id);
    Hooks.callAll('deleteItem', injury, {}, 'u1');
    await flush();
    assert.deepEqual(statuses(actor), []);
});

test('NPC lines are whispered to the GM', async () => {
    const actor = new FakeActor({ name: 'Chull', hasPlayerOwner: false });
    const before = env.chat.length;
    await hudToggle(actor, 'immobilized');
    const msg = env.chat.slice(before)[0];
    assert.deepEqual(msg.whisper, ['gm']);
});

test('the engine switch turns everything off', async () => {
    env.settings.set('enabled', false);
    try {
        const actor = new FakeActor({ name: 'Szeth', speed: 3 });
        await hudToggle(actor, 'prone');
        assert.deepEqual(statuses(actor), ['prone']);
        assert.equal(actor.system.movement.walk.rate.value, 30);
    } finally {
        env.settings.set('enabled', true);
    }
});

test('using a stance action switches the stance on and shows a marker; End Stance removes it', async () => {
    const stonestance = { id: 'T1', type: 'talent', name: 'Stonestance', img: 'stone.svg', system: { id: 'stonestance', modality: 'stance' } };
    const endStance = { id: 'T2', type: 'talent', name: 'End Stance', img: 'end.svg', system: { id: 'end-stance', modality: 'stance' } };
    const action = { id: 'A1', type: 'action', name: 'Stonestance', system: { id: 'stone-stance' } };
    const actor = new FakeActor({ name: 'Kaladin', items: [stonestance, endStance, action] });
    action.system.relationships = [{ type: 'parent', itemType: 'talent', uuid: stonestance.uuid }];

    Hooks.callAll('cosmere-rpg.useItem', action, {});
    await flush();
    assert.deepEqual(actor.modeCalls, [['stance', 'stonestance']]);
    const marker = actor.effects.find((e) => e.statuses.has('ep-stance'));
    assert.equal(marker?.name, 'Stance: Stonestance');

    await api.endStance(actor);
    await flush();
    assert.deepEqual(actor.modeCalls.at(-1), ['stance', 'end-stance']);
    assert.equal(actor.effects.find((e) => e.statuses.has('ep-stance')), undefined);
});

test('a stance action without End Stance: endStance clears the flag and the marker', async () => {
    const vinestance = { id: 'T1', type: 'talent', name: 'Vinestance', img: 'vine.svg', system: { id: 'vinestance', modality: 'stance' } };
    const action = { id: 'A1', type: 'action', name: 'Vinestance', system: { id: 'vine-stance' } };
    const actor = new FakeActor({ name: 'Navani', items: [vinestance, action] });
    Hooks.callAll('cosmere-rpg.useItem', action, {});
    await flush();
    assert.ok(actor.effects.find((e) => e.statuses.has('ep-stance')));
    await api.endStance(actor);
    await flush();
    assert.equal(actor.getFlag('cosmere-rpg', 'mode.stance'), undefined);
    assert.equal(actor.effects.find((e) => e.statuses.has('ep-stance')), undefined);
});
