/**
 * The mechanics layer against the fake Foundry (#4): rules from any effect that applies to the actor, the actor's
 * own and those its items transfer, under the condition's setting or "Rules on other effects".
 * Proves the wiring only; Foundry itself still needs a live pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeActor, FakeEffect, FakeItem, flush, Hooks, installFakeFoundry } from './fake-foundry.js';

const env = installFakeFoundry({ settings: { 'condition.slowed': 'full', 'condition.exhausted': 'full' } });
await import('../scripts/main.js');
Hooks.callAll('init');
const { planFor, skillPenalty } = await import('../scripts/mechanics.js');

const MODULE = 'ep-cosmere-automations';
const HALF = { mechanics: [{ kind: 'movement', op: 'half' }] };
let n = 0;
const effectData = (rules, extra = {}) => ({ _id: `homebrew${String(n++).padStart(8, '0')}`, name: 'Homebrew', flags: { [MODULE]: { rules } }, ...extra });

function otherEffects(mode, actors) {
    env.settings.set('otherEffects', mode);
    for (const actor of actors) actor.reset();
}

/** An actor holding a talent whose effect carries `rules` (transferred, unless `extra` says otherwise). */
function withTalent(rules, extra = {}, actorData = {}) {
    const talent = new FakeItem({ id: 'talent0000000001', name: 'Talent', type: 'talent' });
    const actor = new FakeActor({ name: 'Navani', speed: 3, items: [talent], ...actorData }); // rate 30
    const effect = new FakeEffect(effectData(rules, extra), talent);
    talent.effects.set(effect.id, effect);
    actor.reset();
    return { actor, talent, effect };
}

test('the "Rules on other effects" setting is registered, remind only by default', () => {
    assert.equal(env.settings.get('otherEffects'), 'remind');
});

test('a non-condition effect on the actor halves movement in full mode and does nothing in remind-only mode', async () => {
    const actor = new FakeActor({ name: 'Kal', speed: 3 });
    await actor.createEmbeddedDocuments('ActiveEffect', [effectData(HALF)], { keepId: true });
    await flush();
    assert.equal(actor.system.movement.walk.rate.value, 30, 'remind only: unchanged');

    otherEffects('full', [actor]);
    assert.equal(actor.system.movement.walk.rate.value, 15);
    otherEffects('off', [actor]);
    assert.equal(actor.system.movement.walk.rate.value, 30);
    otherEffects('remind', [actor]);
});

test("a talent's transferred effect counts; a disabled or non-transferring one doesn't", () => {
    const { actor, effect } = withTalent(HALF);
    otherEffects('full', [actor]);
    assert.equal(actor.system.movement.walk.rate.value, 15, 'transferred effect halves');

    effect.updateSource({ disabled: true }); // the system disables the effects of a stance the actor is not in
    actor.reset();
    assert.equal(actor.system.movement.walk.rate.value, 30, 'disabled: no change');

    effect.updateSource({ disabled: false });
    effect.isSuppressed = true;
    actor.reset();
    assert.equal(actor.system.movement.walk.rate.value, 30, 'suppressed: no change');

    const kept = withTalent(HALF, { transfer: false });
    kept.actor.reset();
    assert.equal(kept.actor.system.movement.walk.rate.value, 30, 'not transferred: stays on the item');
    otherEffects('remind', [actor, kept.actor]);
});

test("a condition's own rules follow its own setting, not \"Rules on other effects\"", async () => {
    const actor = new FakeActor({ name: 'Adolin', speed: 3 });
    const status = await CONFIG.ActiveEffect.documentClass.fromStatusEffect('exhausted');
    await actor.createEmbeddedDocuments('ActiveEffect', [status.toObject()], { keepId: true });
    await flush();
    const exhausted = actor.effects.find((e) => e.statuses.has('exhausted'));
    await exhausted.setFlag(MODULE, 'rules', HALF);
    assert.equal(actor.system.movement.walk.rate.value, 15, 'Exhausted is full; other effects are remind only');

    env.settings.set('condition.exhausted', 'remind');
    otherEffects('full', [actor]);
    assert.equal(actor.system.movement.walk.rate.value, 30, 'Exhausted in remind only: unchanged');
    env.settings.set('condition.exhausted', 'full');
    otherEffects('remind', [actor]);
});

test('listed skills change only those skills; skillPenalty reads the same plan', () => {
    const { actor } = withTalent({ mechanics: [{ kind: 'skillModifier', amount: -2, skills: ['per'] }] });
    otherEffects('full', [actor]);
    assert.equal(actor.system.skills.per.mod.value, 0);
    assert.equal(actor.system.skills.ath.mod.value, 2);
    assert.equal(skillPenalty(actor), 0, 'no all-skills penalty');
    assert.equal(skillPenalty(actor, 'per'), 2, 'with the skill: its listed penalty');
    assert.deepEqual(planFor(actor).skillModifiers, { per: -2 });
    otherEffects('remind', [actor]);
    assert.equal(actor.system.skills.per.mod.value, 2);
    assert.equal(skillPenalty(actor, 'per'), 0);
});

test('a fixed attribute bonus is in place before the system derives movement from it', () => {
    const { actor } = withTalent({ mechanics: [{ kind: 'attributeBonus', attribute: 'spd', amount: 2 }] });
    assert.equal(actor.system.movement.walk.rate.value, 30);
    otherEffects('full', [actor]);
    assert.equal(actor.system.attributes.spd.bonus, 2);
    assert.equal(actor.system.movement.walk.rate.value, 40, 'Speed 3 + 2 → 40 ft');
    actor.reset();
    assert.equal(actor.system.attributes.spd.bonus, 2, 'not added twice on a second preparation');
    otherEffects('remind', [actor]);
});

test('the engine switch turns all of it off', () => {
    const { actor } = withTalent(HALF);
    otherEffects('full', [actor]);
    assert.equal(actor.system.movement.walk.rate.value, 15);
    env.settings.set('enabled', false);
    actor.reset();
    assert.equal(actor.system.movement.walk.rate.value, 30);
    assert.equal(planFor(actor), null);
    env.settings.set('enabled', true);
    otherEffects('remind', [actor]);
});
