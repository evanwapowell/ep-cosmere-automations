/**
 * Authoring against the fake Foundry (#8): api.rules, api.setRules, api.validateRules, the Rules control on the
 * effect sheet's header and its dialog. Proves the wiring only: the control on Foundry's real ActiveEffectConfig
 * and the dialog still need a live pass (docs/LIVE-PASS.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeActor, flush, Hooks, installFakeFoundry } from './fake-foundry.js';

const env = installFakeFoundry({
    settings: { 'condition.exhausted': 'full', 'condition.slowed': 'full', 'condition.prone': 'full', otherEffects: 'full', rolls: 'full' },
});
await import('../scripts/main.js');
Hooks.callAll('init');
const { entryToRules } = await import('../scripts/logic/rules.js');
const { CONDITIONS_BY_ID } = await import('../data/conditions.js');
const api = env.module.api;

const MODULE = 'ep-cosmere-automations';

async function hudToggle(actor, id) {
    const effect = await CONFIG.ActiveEffect.documentClass.fromStatusEffect(id);
    await actor.createEmbeddedDocuments('ActiveEffect', [effect.toObject()], { keepId: true });
    await flush();
    return actor.effects.find((e) => e.statuses.has(id));
}

async function homebrew(actor, name = 'Homebrew') {
    const [effect] = await actor.createEmbeddedDocuments('ActiveEffect', [{ name }]);
    await flush();
    return effect;
}

test('the API has rules, setRules and validateRules', () => {
    for (const name of ['rules', 'setRules', 'validateRules']) assert.equal(typeof api[name], 'function', name);
});

test('api.rules: a condition with no rules of its own shows the table\'s, all from the defaults', async () => {
    const actor = new FakeActor({ name: 'Kal' });
    const effect = await hudToggle(actor, 'exhausted');
    const report = api.rules(effect);
    assert.deepEqual(report.rules, entryToRules(CONDITIONS_BY_ID.exhausted));
    assert.deepEqual(report.defaultsFrom, { condition: 'exhausted' });
    assert.equal(report.own, null);
    assert.equal(report.stored, null);
    assert.ok(Object.values(report.from).every((f) => f === 'default'));
    assert.throws(() => api.rules(actor), TypeError, 'an actor is not an effect');
});

test('api.validateRules returns problems, empty when valid', () => {
    assert.deepEqual(api.validateRules({ mechanics: [{ kind: 'movement', op: 'half' }] }), []);
    assert.deepEqual(api.validateRules(null), []);
    assert.match(api.validateRules({ links: ['notACondition'] })[0], /links/);
    assert.match(api.validateRules('half')[0], /object/);
});

test('api.validateRules checks skill ids against the system\'s config when it has them', () => {
    CONFIG.COSMERE.skills = { ath: {}, prc: {} };
    try {
        const rule = (skill) => ({ rolls: [{ who: 'self', mode: 'advantage', tests: { skills: [skill] } }] });
        assert.deepEqual(api.validateRules(rule('ath')), []);
        assert.match(api.validateRules(rule('athletics'))[0], /unknown skill/);
    } finally {
        delete CONFIG.COSMERE.skills;
    }
});

test('api.setRules: invalid rules are not saved and do not throw', async () => {
    const actor = new FakeActor({ name: 'Shallan' });
    const effect = await homebrew(actor);
    const result = await api.setRules(effect, { mechanics: [{ kind: 'teleport' }] });
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /mechanics\[0\]/);
    assert.equal(effect.getFlag(MODULE, 'rules'), undefined, 'nothing written');
    await assert.rejects(api.setRules(actor, {}), TypeError);
});

test('api.setRules: a homebrew effect that halves movement and brings Slowed', async () => {
    const actor = new FakeActor({ name: 'Adolin', speed: 3 }); // walking rate 30
    const effect = await homebrew(actor, 'Mire');
    const result = await api.setRules(effect, { mechanics: [{ kind: 'movement', op: 'half' }], links: ['slowed'] });
    await flush();
    assert.equal(result.ok, true, result.problems.join('; '));
    assert.deepEqual(effect.getFlag(MODULE, 'rules'), { schema: 1, mechanics: [{ kind: 'movement', op: 'half' }], links: ['slowed'] });
    assert.equal(actor.system.movement.walk.rate.value, 15, 'movement halved');
    const report = api.rules(effect);
    assert.deepEqual(report.from, { mechanics: 'effect', links: 'effect' });
    assert.equal(report.defaultsFrom, null);
});

test('api.setRules: a talent-style effect gives advantage on a skill', async () => {
    const actor = new FakeActor({ name: 'Lift' });
    const effect = await homebrew(actor, 'Nimble');
    const before = api.modifiers(actor, { context: 'Skill', skill: 'agi' });
    assert.equal(before.mode, 'none');
    const result = await api.setRules(effect, { rolls: [{ who: 'self', mode: 'advantage', tests: { skills: ['agi'] } }] });
    assert.equal(result.ok, true, result.problems.join('; '));
    assert.equal(api.modifiers(actor, { context: 'Skill', skill: 'agi' }).mode, 'advantage');
    assert.equal(api.modifiers(actor, { context: 'Skill', skill: 'ath' }).mode, 'none', 'other skills untouched');
});

test('api.setRules replaces the old rules as a whole; null resets a condition to its defaults', async () => {
    const actor = new FakeActor({ name: 'Rock', speed: 3 });
    const effect = await hudToggle(actor, 'exhausted');
    await api.setRules(effect, { mechanics: [{ kind: 'movement', op: 'zero' }], longRest: 0 });
    assert.equal(actor.system.movement.walk.rate.value, 0);
    await api.setRules(effect, { longRest: 2 });
    assert.deepEqual(effect.getFlag(MODULE, 'rules'), { schema: 1, longRest: 2 }, 'the old mechanics did not survive');
    assert.deepEqual(api.rules(effect).rules.mechanics, entryToRules(CONDITIONS_BY_ID.exhausted).mechanics);

    const reset = await api.setRules(effect, null);
    assert.deepEqual(reset, { ok: true, problems: [], rules: null });
    assert.equal(effect.getFlag(MODULE, 'rules'), undefined, 'flag gone');
    assert.deepEqual(api.rules(effect).rules, entryToRules(CONDITIONS_BY_ID.exhausted), 'the defaults again');
    assert.equal(actor.system.movement.walk.rate.value, 30);
});

/* --- The Rules control and dialog --- */

const fakeSheet = (effect) => ({ document: effect, options: { actions: {} } });

test('the sheet header gets a Rules control for the GM only, once', async () => {
    const actor = new FakeActor({ name: 'Teft' });
    const effect = await hudToggle(actor, 'prone');
    const app = fakeSheet(effect);
    const controls = [];
    Hooks.callAll('getHeaderControlsActiveEffectConfig', app, controls);
    assert.equal(controls.length, 1);
    assert.equal(controls[0].action, 'ep-cosmere-automations-rules');
    assert.equal(typeof controls[0].onClick, 'function');
    assert.equal(typeof app.options.actions['ep-cosmere-automations-rules'], 'function');
    Hooks.callAll('getHeaderControlsActiveEffectConfig', app, controls);
    assert.equal(controls.length, 1, 'not added twice');

    game.user.isGM = false;
    try {
        const theirs = [];
        Hooks.callAll('getHeaderControlsActiveEffectConfig', fakeSheet(effect), theirs);
        assert.equal(theirs.length, 0, 'players get no control');
    } finally {
        game.user.isGM = true;
    }
});

test('a broken sheet does not throw out of the hook', () => {
    assert.doesNotThrow(() => Hooks.callAll('getHeaderControlsActiveEffectConfig', null, null));
    assert.doesNotThrow(() => Hooks.callAll('getHeaderControlsActiveEffectConfig', { document: {} }, []));
});

/** A DOM-less stand-in for the dialog's element: the textarea, the problem list and the Save button. */
function fakeElement(text) {
    const listeners = {};
    const area = { value: text, addEventListener: (type, fn) => (listeners[type] = fn) };
    const list = { innerHTML: '' };
    const save = { disabled: false };
    const nodes = { 'textarea[name="rules"]': area, '.ep-rules-problems': list, 'button[data-action="save"]': save };
    return { root: { querySelector: (sel) => nodes[sel] ?? null }, area, list, save, type: (value) => ((area.value = value), listeners.input()) };
}

/** DialogV2, reduced to what the Rules dialog uses: it records its options and renders a fake element. */
class FakeDialog {
    static last = null;
    constructor(options) {
        this.options = options;
        this.rendered = false;
        FakeDialog.last = this;
    }
    addEventListener() {}
    async render() {
        this.rendered = true;
        const match = /<textarea name="rules"[^>]*>([\s\S]*?)<\/textarea>/.exec(this.options.content);
        this.fake = fakeElement(match ? match[1].replaceAll('&quot;', '"') : '');
        this.element = this.fake.root;
        return this;
    }
    bringToFront() {
        this.front = true;
    }
    async press(action, text) {
        const button = this.options.buttons.find((b) => b.action === action);
        const result = button.callback({}, { form: { elements: { rules: { value: text ?? this.fake.area.value } } } }, this);
        this.rendered = false;
        await this.options.submit(result);
        await flush();
    }
}

test('the dialog shows the resolved rules, keeps Save disabled while invalid, saves and resets', async () => {
    const original = foundry.applications.api.DialogV2;
    foundry.applications.api.DialogV2 = FakeDialog;
    try {
        const { openRulesDialog } = await import('../scripts/authoring.js');
        const actor = new FakeActor({ name: 'Sigzil', speed: 3 });
        const effect = await hudToggle(actor, 'slowed');
        const app = fakeSheet(effect);
        const controls = [];
        Hooks.callAll('getHeaderControlsActiveEffectConfig', app, controls);

        await controls[0].onClick();
        const dialog = FakeDialog.last;
        assert.ok(dialog, 'a dialog opened');
        assert.match(dialog.options.content, /What it does now/);
        assert.match(dialog.options.content, /mechanics/);
        assert.equal(dialog.fake.area.value, '', 'no own rules: a blank editor');
        assert.deepEqual(dialog.options.buttons.map((b) => b.action), ['save', 'reset', 'cancel']);

        // Opening it again (onClick and the action both fire, or a second click) brings it forward instead.
        await app.options.actions['ep-cosmere-automations-rules']();
        assert.equal(FakeDialog.last, dialog);
        assert.ok(dialog.front);

        dialog.fake.type('{"mechanics": [{"kind": "teleport"}]}');
        assert.equal(dialog.fake.save.disabled, true, 'invalid: Save disabled');
        assert.match(dialog.fake.list.innerHTML, /mechanics\[0\]/);
        dialog.fake.type('{ not json');
        assert.equal(dialog.fake.save.disabled, true);
        assert.match(dialog.fake.list.innerHTML, /not valid JSON/);
        dialog.fake.type('{"mechanics": [{"kind": "movement", "op": "zero"}]}');
        assert.equal(dialog.fake.save.disabled, false, 'valid: Save enabled');
        assert.equal(dialog.fake.list.innerHTML, '');

        await dialog.press('save');
        assert.deepEqual(effect.getFlag(MODULE, 'rules'), { schema: 1, mechanics: [{ kind: 'movement', op: 'zero' }] });
        assert.equal(actor.system.movement.walk.rate.value, 0, 'the edit changes movement');

        // Opened again: the editor starts from the saved rules; Reset to defaults clears them.
        await openRulesDialog(effect);
        const second = FakeDialog.last;
        assert.notEqual(second, dialog);
        assert.deepEqual(JSON.parse(second.fake.area.value), effect.getFlag(MODULE, 'rules'));
        await second.press('reset');
        assert.equal(effect.getFlag(MODULE, 'rules'), undefined);
        assert.equal(actor.system.movement.walk.rate.value, 15, 'Slowed halves again');

        // Cancel changes nothing; an invalid text that somehow reaches submit is refused with a warning.
        await openRulesDialog(effect);
        await FakeDialog.last.press('cancel');
        await openRulesDialog(effect);
        await FakeDialog.last.press('save', '{"longRest": -1}');
        assert.equal(effect.getFlag(MODULE, 'rules'), undefined);
        assert.match(env.warnings.at(-1), /not saved/i);
    } finally {
        foundry.applications.api.DialogV2 = original;
    }
});

test('the dialog does not open for a player', async () => {
    const { openRulesDialog } = await import('../scripts/authoring.js');
    const actor = new FakeActor({ name: 'Moash' });
    const effect = await hudToggle(actor, 'prone');
    game.user.isGM = false;
    try {
        assert.equal(await openRulesDialog(effect), null);
    } finally {
        game.user.isGM = true;
    }
});
