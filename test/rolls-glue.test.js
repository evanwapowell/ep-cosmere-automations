/**
 * The roll layer through the Foundry glue, against fake versions of the system's skill and attack flows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeActor, flush, Hooks, installFakeFoundry, rollAttack, rollSkill } from './fake-foundry.js';

const CONDITION_IDS = [
    'afflicted', 'enhanced', 'exhausted', 'immobilized', 'prone', 'restrained', 'slowed', 'unconscious', 'stunned',
    'surprised', 'empowered', 'disoriented', 'flying', 'blind', 'hidden', 'invisible',
];
const env = installFakeFoundry({
    settings: {
        ...Object.fromEntries(CONDITION_IDS.map((id) => [`condition.${id}`, 'full'])),
        durations: 'full',
        stances: 'full',
        rolls: 'full',
        actionEffects: 'full',
        otherEffects: 'full',
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
    delete globalThis.__dialogAttribute;
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

test('the system\'s "Strike: X" actions: melee from the parent weapon or the adversary description', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const brute = new FakeActor({ name: 'Brute', type: 'adversary', hasPlayerOwner: false });
    await api.apply(brute, 'prone');
    await flush();
    target(brute);
    // A character's attack: the weapon's strike action, embedded in the weapon (no attack data of its own).
    const weapon = { name: 'Sidesword', system: { attack: { type: 'melee' } } };
    const strike = { id: 'S1', uuid: `${kal.uuid}.Item.W1.Item.ephdoc0000000000`, name: 'Strike: Sidesword', type: 'action', actor: kal, parent: weapon, system: { skill: 'lwp' } };
    await rollAttack(kal, strike);
    assert.equal(globalThis.__dialogPreset, 'advantage');

    // An adversary's strike: a plain action whose description gives Reach or Range.
    reset();
    target(brute);
    const mace = { id: 'S2', uuid: `${kal.uuid}.Item.S2`, name: 'Strike: Mace', type: 'action', actor: kal, parent: kal, system: { skill: 'lwp', description: { value: '<p>Attack +2; Reach 5 ft.; Targets one</p>' } } };
    await rollAttack(kal, mace);
    assert.equal(globalThis.__dialogPreset, 'advantage');
    reset();
    target(brute);
    const bow = { ...mace, id: 'S3', uuid: `${kal.uuid}.Item.S3`, system: { skill: 'lwp', description: { value: 'Attack +2; Range 80/120 ft.' } } };
    await rollAttack(kal, bow);
    assert.notEqual(globalThis.__dialogPreset, 'advantage');
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
    delete globalThis.__dialogAttribute;
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

test('Hidden or Invisible target: attacks against it gain a disadvantage; other tests do not', async () => {
    for (const status of ['hidden', 'invisible']) {
        reset();
        const kal = new FakeActor({ name: 'Kal' });
        const brute = new FakeActor({ name: 'Brute', type: 'adversary', hasPlayerOwner: false });
        await api.apply(brute, status);
        await flush();
        target(brute);
        await rollAttack(kal, sword(kal));
        assert.equal(globalThis.__dialogPreset, 'disadvantage', status);
        assert.equal((await rollSkill(kal, 'ins', { fastForward: true })).options.advantageMode, 'none', `${status}: not a skill test`);
    }
});

test('Senseblind: attacks on a target beyond the senses range gain a disadvantage, within it they do not', async () => {
    reset();
    const previousCanvas = globalThis.canvas;
    // 100 px per 5 ft square.
    globalThis.canvas = { grid: { measurePath: ([a, b]) => ({ distance: (Math.hypot(b.x - a.x, b.y - a.y) / 100) * 5 }) } };
    try {
        const kal = new FakeActor({ name: 'Kal' });
        const brute = new FakeActor({ name: 'Brute', type: 'adversary', hasPlayerOwner: false });
        kal.getActiveTokens = () => [{ center: { x: 0, y: 0 } }];
        await api.apply(kal, 'blind');
        await flush();
        kal.system.senses = { range: { value: 10 }, obscuredAffected: true };
        const at = (squares) => {
            game.user.targets = new Set([{ actor: brute, center: { x: squares * 100, y: 0 } }]);
        };

        at(4); // 20 ft
        await rollAttack(kal, sword(kal));
        assert.equal(globalThis.__dialogPreset, 'disadvantage', 'beyond 10 ft');
        at(1); // 5 ft
        await rollAttack(kal, sword(kal));
        assert.notEqual(globalThis.__dialogPreset, 'disadvantage', 'within range');
        at(4);
        kal.system.senses.obscuredAffected = false;
        await rollAttack(kal, sword(kal));
        assert.notEqual(globalThis.__dialogPreset, 'disadvantage', 'senses not affected by obscurement');
    } finally {
        globalThis.canvas = previousCanvas;
    }
});

test('Exhausted stays on a skill test rolled with another attribute (option or dialog), once', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    await api.apply(kal, 'exhausted', { stacks: 2 });
    await flush();
    const penalty = (roll) => roll.terms.slice(3).map((t) => t.operator ?? t.number).join(' ');

    assert.equal(penalty(await rollSkill(kal, 'ath', { fastForward: true })), '', 'own attribute: already in the modifier');
    assert.equal(penalty(await rollSkill(kal, 'ath', { fastForward: true, attribute: 'int' })), '- 2', 'attribute option');
    globalThis.__dialogAttribute = 'int';
    assert.equal(penalty(await rollSkill(kal, 'ath')), '- 2', 'changed in the dialog');
    assert.equal(penalty(await rollSkill(kal, 'ath', { attribute: 'int' })), '- 2', 'option and dialog: added once');
    delete globalThis.__dialogAttribute;
    assert.equal(penalty(await rollSkill(kal, 'ath')), '', 'dialog without a change');
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

/* --- Rules on any effect (step 4 of portable rules) --- */

const MODULE = 'ep-cosmere-automations';
const ruleEffect = async (actor, name, rolls) => {
    const [effect] = await actor.createEmbeddedDocuments('ActiveEffect', [{ name, flags: { [MODULE]: { rules: { rolls } } } }]);
    await flush();
    return effect;
};

test('a plain effect with its own roll rule: disadvantage on ranged attacks, not on melee', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const brute = new FakeActor({ name: 'Brute' });
    await ruleEffect(kal, 'Shaky Hands', [{ who: 'self', mode: 'disadvantage', tests: 'ranged' }]);
    target(brute);
    const shot = await rollAttack(kal, bow(kal), { fastForward: true });
    assert.equal(shot.options.advantageMode, 'disadvantage');
    assert.equal(shot.options[MODULE].note, 'Disadvantage: Shaky Hands.', 'the effect\'s name on the card');
    const swing = await rollAttack(kal, sword(kal), { fastForward: true });
    assert.equal(swing.options.advantageMode, 'none');

    const preview = api.modifiers(kal, { target: brute, context: 'Attack', attackType: 'ranged' });
    assert.equal(preview.mode, 'disadvantage');
    assert.deepEqual(preview.modifiers.map((m) => m.label), ['Shaky Hands']);
});

test('"Rules on other effects" in remind mode: the card lists them, the roll is unchanged; conditions still apply', async () => {
    reset();
    env.settings.set('otherEffects', 'remind');
    try {
        const kal = new FakeActor({ name: 'Kal' });
        await ruleEffect(kal, 'Hex', [{ who: 'self', mode: 'disadvantage', tests: 'all' }]);
        const roll = await rollSkill(kal, 'ath', { fastForward: true });
        assert.equal(roll.options.advantageMode, 'none');
        assert.equal(roll.options[MODULE].note, 'Not applied (remind only): Hex (disadvantage).');
        await api.apply(kal, 'empowered');
        await flush();
        assert.equal((await rollSkill(kal, 'ath', { fastForward: true })).options.advantageMode, 'advantage');
    } finally {
        env.settings.set('otherEffects', 'full');
    }
});

test('a consumed rule on a custom effect ends that effect after the test', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const charm = await ruleEffect(kal, 'Lucky Charm', [{ who: 'self', mode: 'advantage', tests: 'all', consume: true }]);
    assert.equal((await rollSkill(kal, 'ath', { fastForward: true })).options.advantageMode, 'advantage');
    await flush();
    assert.equal(kal.effects.has(charm.id), false, 'used up');
    assert.equal((await rollSkill(kal, 'ath', { fastForward: true })).options.advantageMode, 'none');
});

test('Flamestance through the stance marker; the marker\'s own rules win over the table', async () => {
    reset();
    const flamestance = { id: 'T1', type: 'talent', name: 'Flamestance', img: 'flame.svg', system: { id: 'flamestance', modality: 'stance' } };
    const kal = new FakeActor({ name: 'Kal', items: [flamestance] });
    await kal.setMode('stance', 'flamestance');
    await flush();
    const marker = kal.effects.find((e) => e.getFlag(MODULE, 'stanceMarker') === 'flamestance');
    assert.ok(marker, 'the marker is there');
    const roll = await rollSkill(kal, 'inm', { fastForward: true });
    assert.equal(roll.options.advantageMode, 'advantage');
    assert.equal(roll.options[MODULE].note, 'Advantage: Flamestance.');
    assert.equal((await rollSkill(kal, 'prs', { fastForward: true })).options.advantageMode, 'none');

    await marker.setFlag(MODULE, 'rules', { rolls: [{ who: 'self', mode: 'advantage', tests: { skills: ['prs'] } }] });
    assert.equal((await rollSkill(kal, 'inm', { fastForward: true })).options.advantageMode, 'none', 'own rules replace the default');
    assert.equal((await rollSkill(kal, 'prs', { fastForward: true })).options.advantageMode, 'advantage');

    await marker.setFlag(MODULE, 'rules', { rolls: [] });
    assert.equal((await rollSkill(kal, 'inm', { fastForward: true })).options.advantageMode, 'none', 'none of its own: no fallback to the table');
});

test('a custom effect on the target: attacks against it gain a disadvantage', async () => {
    reset();
    const kal = new FakeActor({ name: 'Kal' });
    const brute = new FakeActor({ name: 'Brute', type: 'adversary', hasPlayerOwner: false });
    await ruleEffect(brute, 'Smoke Cloud', [{ who: 'target', mode: 'disadvantage', tests: 'attack' }]);
    target(brute);
    const roll = await rollAttack(kal, sword(kal), { fastForward: true });
    assert.equal(roll.options.advantageMode, 'disadvantage');
    assert.equal(roll.options[MODULE].note, 'Disadvantage: target Smoke Cloud.');
});
