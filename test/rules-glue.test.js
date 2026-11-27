/**
 * The resolver glue (scripts/rules.js) against the fake Foundry: own rules over the table, one warning per effect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeActor, flush, Hooks, installFakeFoundry } from './fake-foundry.js';

const FULL = Object.fromEntries(['exhausted', 'prone', 'slowed', 'surprised'].map((id) => [`condition.${id}`, 'full']));
const env = installFakeFoundry({ settings: { ...FULL, stances: 'full' } });
await import('../scripts/main.js');
Hooks.callAll('init');
const { rulesOf, ruleEffects } = await import('../scripts/rules.js');
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

/** Capture console.warn for the length of a callback (which may be async). */
async function captureWarnings(fn) {
    const seen = [];
    const original = console.warn;
    console.warn = (...args) => seen.push(args.join(' '));
    try {
        await fn();
    } finally {
        console.warn = original;
    }
    return seen;
}

test('an effect with no rules of its own has the table\'s', async () => {
    const actor = new FakeActor({ name: 'Kal' });
    const effect = await hudToggle(actor, 'exhausted');
    assert.deepEqual(rulesOf(effect), entryToRules(CONDITIONS_BY_ID.exhausted));
});

test('an effect\'s own rules override the table field by field', async () => {
    const actor = new FakeActor({ name: 'Shallan', speed: 3 }); // walking rate 30
    const effect = await hudToggle(actor, 'exhausted');
    const own = { mechanics: [{ kind: 'movement', op: 'half' }] };
    await effect.setFlag(MODULE, 'rules', own);

    const rules = rulesOf(effect);
    assert.deepEqual(rules.mechanics, [{ kind: 'movement', op: 'half' }], 'the own mechanics');
    assert.equal(rules.longRest, CONDITIONS_BY_ID.exhausted.longRest, 'the table\'s long-rest step');
    assert.equal(actor.system.movement.walk.rate.value, 15, 'the mechanics layer follows the effect\'s rules');
});

test('invalid own rules fall back to the table and warn once per effect', async () => {
    const actor = new FakeActor({ name: 'Lift', speed: 3 });
    const effect = await hudToggle(actor, 'slowed');
    // Changing the flag prepares the actor again, which reads the rules: the warning can come from there.
    const warnings = await captureWarnings(async () => {
        await effect.setFlag(MODULE, 'rules', { mechanics: [{ kind: 'teleport' }] });
        for (let i = 0; i < 3; i++) assert.deepEqual(rulesOf(effect), entryToRules(CONDITIONS_BY_ID.slowed));
        ruleEffects(actor);
    });
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], /mechanics\[0\]/);
    assert.equal(actor.system.movement.walk.rate.value, 15, 'Slowed still halves');

    // A different mistake is a new warning; fixing it clears the memory.
    const again = await captureWarnings(async () => {
        await effect.setFlag(MODULE, 'rules', { longRest: -1 });
        rulesOf(effect);
    });
    assert.equal(again.length, 1, again.join('\n'));
    const fixed = await captureWarnings(async () => {
        await effect.setFlag(MODULE, 'rules', { longRest: 1 });
        rulesOf(effect);
    });
    assert.equal(fixed.length, 0);
});

test('ruleEffects lists enabled, unsuppressed effects that have rules, with what they stand for', async () => {
    const actor = new FakeActor({ name: 'Dalinar' });
    const exhausted = await hudToggle(actor, 'exhausted');
    const surprised = await hudToggle(actor, 'surprised');
    await api.mark(actor, 'dodging');
    await flush();

    const rows = ruleEffects(actor);
    const byCondition = (id) => rows.find((r) => r.conditionId === id);
    assert.ok(byCondition('exhausted'));
    assert.equal(byCondition('exhausted').effect, exhausted);
    assert.equal(byCondition('exhausted').stacks, exhausted.system?.stacks);
    const dodging = rows.find((r) => r.situationalId === 'dodging');
    assert.ok(dodging?.rules.rolls?.length);
    assert.equal(dodging.conditionId, null);

    const all = ruleEffects(actor, { includeEmpty: true });
    assert.ok(all.some((r) => r.effect === surprised), 'includeEmpty lists markers too');

    await exhausted.update({ disabled: true });
    assert.ok(!ruleEffects(actor).some((r) => r.effect === exhausted), 'disabled effects are left out');
    await exhausted.update({ disabled: false });
    exhausted.isSuppressed = true;
    assert.ok(!ruleEffects(actor).some((r) => r.effect === exhausted), 'so are suppressed ones');
});

test('rules carried by a plain effect (no table entry) resolve to just their own', () => {
    const actor = new FakeActor({ name: 'Rock' });
    const plain = { _id: 'abcdefghij012345', name: 'Homebrew', flags: { [MODULE]: { rules: { rolls: [{ who: 'self', mode: 'advantage', tests: 'all' }] } } } };
    return actor.createEmbeddedDocuments('ActiveEffect', [plain], { keepId: true }).then(([effect]) => {
        assert.deepEqual(rulesOf(effect), { schema: 1, rolls: [{ who: 'self', mode: 'advantage', tests: 'all' }] });
        assert.deepEqual(rulesOf(effect), ruleEffects(actor)[0].rules);
    });
});
