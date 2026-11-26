/**
 * The roll layer through the Foundry glue, against fake versions of the system's skill and attack flows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeActor, flush, Hooks, installFakeFoundry, rollAttack, rollSkill } from './fake-foundry.js';

const CONDITION_IDS = [
    'afflicted', 'enhanced', 'exhausted', 'immobilized', 'prone', 'restrained', 'slowed', 'unconscious', 'stunned',
    'surprised', 'empowered', 'disoriented', 'flying',
];
const env = installFakeFoundry({
    settings: {
        ...Object.fromEntries(CONDITION_IDS.map((id) => [`condition.${id}`, 'full'])),
        durations: 'full',
        stances: 'full',
        rolls: 'full',
        actionEffects: 'full',
    },
});
await import('../scripts/main.js');
Hooks.callAll('init');
Hooks.callAll('ready');
const api = env.module.api;

const sword = (actor) => ({ id: 'W1', uuid: `${actor.uuid}.Item.W1`, name: 'Sword', actor, system: { skill: 'hwp', attack: { type: 'melee' } } });
const bow = (actor) => ({ id: 'W2', uuid: `${actor.uuid}.Item.W2`, name: 'Bow', actor, system: { skill: 'lwp', attack: { type: 'ranged' } } });
const target = (actor) => {
    game.user.targets = new Set(actor ? [{ actor }] : []);
};
const has = (actor, status) => actor.effects.some((e) => e.statuses.has(status));
const reset = () => {
    delete globalThis.__dialogChoice;
    delete globalThis.__dialogPreset;
    delete globalThis.__cancelDialog;
    target(null);
};

test('a Restrained roller: fast-forwarded skill tests get a disadvantage, with a note', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    await api.apply(kal, 'restrained');
    await flush();
    const roll = await rollSkill(kal, 'ath', { fastForward: true });
    assert.equal(roll.options.advantageMode, 'disadvantage');
    assert.equal(roll.formula, '2d20kl');
    assert.equal(roll.options['ep-cosmere-automations'].note, 'Disadvantage: Restrained.');
});

test('the skill dialog opens with the disadvantage selected, and the player can drop it (escape test)', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    await api.apply(kal, 'restrained');
    await flush();
    globalThis.__dialogChoice = 'none';
    const roll = await rollSkill(kal, 'ath');
    assert.equal(globalThis.__dialogPreset, 'disadvantage');
    assert.equal(roll.options.advantageMode, 'none');
});

/** Just enough DOM for the chat card: class lookup, prepend, before, replaceWith. */
class El {
    constructor(className = '') {
        this.className = className;
        this.children = [];
        this.parentElement = null;
        this.style = {};
        this.innerHTML = '';
    }
    querySelector(selector) {
        const cls = selector.split('.').at(-1);
        for (const child of this.children) {
            if (child.className.split(' ').includes(cls)) return child;
            const found = child.querySelector(selector);
            if (found) return found;
        }
        return null;
    }
    append(el) {
        el.parentElement = this;
        this.children.push(el);
    }
    prepend(el) {
        el.parentElement = this;
        this.children.unshift(el);
    }
    before(el) {
        el.parentElement = this.parentElement;
        this.parentElement.children.splice(this.parentElement.children.indexOf(this), 0, el);
    }
    replaceWith(el) {
        el.parentElement = this.parentElement;
        this.parentElement.children[this.parentElement.children.indexOf(this)] = el;
    }
}

test('the card note survives the system replacing the message content after the render hook', () => {
    const previous = globalThis.document;
    globalThis.document = { createElement: () => new El() };
    try {
        const root = new El('chat-message');
        root.append(new El('message-header'));
        const content = new El('message-content');
        root.append(content);
        const message = { rolls: [{ options: { 'ep-cosmere-automations': { note: 'Disadvantage: Restrained.' } } }], getFlag: () => undefined };
        Hooks.callAll('renderChatMessageHTML', message, root);
        // What cosmere-rpg 3.1.2's ChatMessage.renderHTML does next: its own card replaces the content.
        content.replaceWith(new El('message-content'));
        const note = root.querySelector('.ep-cosmere-automations-roll-note');
        assert.ok(note, 'note still there');
        assert.match(note.innerHTML, /Disadvantage: Restrained\./);
        Hooks.callAll('renderChatMessageHTML', message, root);
        assert.equal(root.children.filter((c) => c.className === 'ep-cosmere-automations-roll-note').length, 1, 'not added twice');
    } finally {
        globalThis.document = previous;
    }
});

test('a shift-click advantage and Restrained cancel out', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    await api.apply(kal, 'restrained');
    await flush();
    const roll = await rollSkill(kal, 'ath', { fastForward: true, advantageMode: 'advantage' });
    assert.equal(roll.options.advantageMode, 'none');
});

test('melee against a Prone target: the attack dialog starts with an advantage; ranged does not', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const brute = new FakeActor({ name: 'Brute', type: 'adversary', hasPlayerOwner: false });
    await api.apply(brute, 'prone');
    await flush();
    target(brute);
    const roll = await rollAttack(kal, sword(kal));
    assert.equal(globalThis.__dialogPreset, 'advantage');
    assert.equal(roll.options.advantageMode, 'advantage', 'not applied twice, not lost');
    assert.match(roll.options['ep-cosmere-automations'].note, /target Prone/);

    const shot = await rollAttack(kal, bow(kal), { fastForward: true });
    assert.equal(shot.options.advantageMode, 'none');
});

test('a player who removes the advantage in the attack dialog keeps that choice', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const brute = new FakeActor({ name: 'Brute' });
    await api.apply(brute, 'prone');
    await flush();
    target(brute);
    globalThis.__dialogChoice = 'none';
    const roll = await rollAttack(kal, sword(kal));
    assert.equal(roll.options.advantageMode, 'none');
});

test('a cancelled attack dialog does not stop the next fast-forwarded attack from getting its modifiers', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const brute = new FakeActor({ name: 'Brute' });
    await api.apply(brute, 'prone');
    await flush();
    target(brute);
    const weapon = sword(kal);
    globalThis.__cancelDialog = true;
    assert.equal(await rollAttack(kal, weapon), null);
    delete globalThis.__cancelDialog;
    const roll = await rollAttack(kal, weapon, { fastForward: true });
    assert.equal(roll.options.advantageMode, 'advantage');
});

test('Dodge: the next attack against the dodger gains a disadvantage, then Dodging is gone', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const brute = new FakeActor({ name: 'Brute' });
    Hooks.callAll('cosmere-rpg.useItem', { name: 'Dodge', img: 'dodge.svg', actor: kal, system: { id: 'dodge' } }, {});
    await flush();
    assert.ok(has(kal, 'ep-dodging'));
    target(kal);
    const first = await rollAttack(brute, sword(brute), { fastForward: true });
    assert.equal(first.options.advantageMode, 'disadvantage');
    assert.equal(has(kal, 'ep-dodging'), false, 'used up');
    const second = await rollAttack(brute, sword(brute), { fastForward: true });
    assert.equal(second.options.advantageMode, 'none');
});

test('a player\'s attack uses up an NPC\'s Dodging through the GM relay', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const brute = new FakeActor({ name: 'Brute', hasPlayerOwner: false });
    await api.mark(brute, 'dodging');
    await flush();
    brute.isOwner = false;
    game.user.isGM = false;
    try {
        target(brute);
        await rollAttack(kal, sword(kal), { fastForward: true });
        assert.equal(env.socket.emitted.length, 0, 'no GM connected: no request');
        game.users.activeGM = { id: 'gm' };
        await rollAttack(kal, sword(kal), { fastForward: true });
        assert.deepEqual(env.socket.emitted.at(-1), {
            type: 'consume',
            actorUuid: brute.uuid,
            effectId: brute.effects.find((e) => e.statuses.has('ep-dodging')).id,
            userId: 'u1',
        });
        // The GM's client receives it.
        game.user.isGM = true;
        game.users.activeGM = { id: 'u1' };
        for (const handler of env.socket.handlers) await handler(env.socket.emitted.at(-1));
        await flush();
        assert.equal(has(brute, 'ep-dodging'), false);
    } finally {
        game.user.isGM = true;
        delete game.users.activeGM;
    }
});

test('the relay refuses anything that is not a used-up situational effect', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    await api.apply(kal, 'restrained');
    await flush();
    const effect = kal.effects.contents[0];
    for (const handler of env.socket.handlers) await handler({ type: 'consume', actorUuid: kal.uuid, effectId: effect.id });
    await flush();
    assert.ok(has(kal, 'restrained'));
});

test('Brace: attacks against the bracer gain a disadvantage; it ends when the bracer attacks or moves', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const brute = new FakeActor({ name: 'Brute' });
    await api.mark(kal, 'bracing');
    await flush();
    target(kal);
    const roll = await rollAttack(brute, sword(brute), { fastForward: true });
    assert.equal(roll.options.advantageMode, 'disadvantage');
    assert.ok(has(kal, 'ep-bracing'), 'not used up by being attacked');

    target(brute);
    await rollAttack(kal, sword(kal), { fastForward: true });
    assert.equal(has(kal, 'ep-bracing'), false, 'ends when it attacks');

    await api.mark(kal, 'bracing');
    await flush();
    Hooks.callAll('updateToken', { actor: kal }, { x: 100 }, {}, 'u1');
    await flush();
    assert.equal(has(kal, 'ep-bracing'), false, 'ends when it moves');
});

test('Gain Advantage: a card with a button; the advantage applies to the next test against that enemy only', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const brute = new FakeActor({ name: 'Brute' });
    const other = new FakeActor({ name: 'Other' });
    target(brute);
    const before = env.chat.length;
    Hooks.callAll('cosmere-rpg.useItem', { name: 'Gain Advantage', img: 'ga.svg', actor: kal, system: { id: 'gain_advantage' } }, {});
    await flush();
    const card = env.chat.slice(before).find((m) => m.flags?.['ep-cosmere-automations']?.grant);
    assert.ok(card, 'card posted');
    assert.equal(has(kal, 'ep-advantage'), false, 'nothing until the player confirms success');

    // The button's action (the DOM wiring is Foundry's part).
    await api.mark(kal, 'advantage', { target: brute });
    await flush();
    target(other);
    assert.equal((await rollSkill(kal, 'ded', { fastForward: true })).options.advantageMode, 'none');
    target(brute);
    assert.equal((await rollSkill(kal, 'ded', { fastForward: true })).options.advantageMode, 'advantage');
    assert.equal(has(kal, 'ep-advantage'), false, 'used up');
});

test('Flamestance: advantage on Intimidation', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    await kal.setMode('stance', 'flamestance');
    await flush();
    assert.equal((await rollSkill(kal, 'inm', { fastForward: true })).options.advantageMode, 'advantage');
    assert.equal((await rollSkill(kal, 'prs', { fastForward: true })).options.advantageMode, 'none');
});

test('remind mode: the card lists them, the roll is unchanged', async () => {
    reset();
    env.settings.set('rolls', 'remind');
    try {
        const kal = new FakeActor({ name: 'Kal' });
        await api.apply(kal, 'restrained');
        await flush();
        const roll = await rollSkill(kal, 'ath', { fastForward: true });
        assert.equal(roll.options.advantageMode, 'none');
        assert.match(roll.options['ep-cosmere-automations'].note, /Not applied/);
    } finally {
        env.settings.set('rolls', 'full');
    }
});

test('a condition in remind mode is only listed even when rolls are full', async () => {
    reset();
    env.settings.set('condition.restrained', 'remind');
    try {
        const kal = new FakeActor({ name: 'Kal' });
        await api.apply(kal, 'restrained');
        await flush();
        assert.equal((await rollSkill(kal, 'ath', { fastForward: true })).options.advantageMode, 'none');
    } finally {
        env.settings.set('condition.restrained', 'full');
    }
});

test('action effects in remind mode: a chat line, no effect', async () => {
    reset();
    env.settings.set('actionEffects', 'remind');
    try {
        const kal = new FakeActor({ name: 'Kal' });
        const before = env.chat.length;
        Hooks.callAll('cosmere-rpg.useItem', { name: 'Brace', actor: kal, system: { id: 'brace' } }, {});
        await flush();
        assert.equal(has(kal, 'ep-bracing'), false);
        assert.ok(env.chat.slice(before).some((m) => m.content.includes('Bracing')));
    } finally {
        env.settings.set('actionEffects', 'full');
    }
});

test('api.modifiers previews a test', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const brute = new FakeActor({ name: 'Brute' });
    await api.apply(brute, 'flying');
    await api.apply(kal, 'empowered');
    await flush();
    const preview = api.modifiers(kal, { target: brute, context: 'Attack', attackType: 'ranged' });
    assert.equal(preview.mode, 'none');
    assert.deepEqual(preview.modifiers.map((m) => m.key).sort(), ['empowered', 'flying']);
});
