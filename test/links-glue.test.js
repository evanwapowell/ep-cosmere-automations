/**
 * Links, held sources and the long-rest step for any effect (step 5 of portable rules), against the fake Foundry:
 * a custom effect can bring conditions and end them again; link loops stop with a warning; a long rest takes stacks
 * off any effect whose rules say so, unless a source holds it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeActor, FakeItem, flush, Hooks, installFakeFoundry } from './fake-foundry.js';

const IDS = ['exhausted', 'immobilized', 'prone', 'restrained', 'slowed', 'stunned'];
const env = installFakeFoundry({
    settings: { ...Object.fromEntries(IDS.map((id) => [`condition.${id}`, 'full'])), durations: 'full', stances: 'full', otherEffects: 'full' },
});
await import('../scripts/main.js');
Hooks.callAll('init');
const { CONDITIONS_BY_ID } = await import('../data/conditions.js');
const api = env.module.api;

const MODULE = 'ep-cosmere-automations';
const statuses = (actor) => actor.effects.contents.filter((e) => e.statuses.size).map((e) => [...e.statuses][0]).sort();
const has = (actor, id) => actor.effects.some((e) => e.statuses.has(id));
const effectOf = (actor, id) => actor.effects.find((e) => e.statuses.has(id));
const sourcesOf = (effect) => effect.getFlag(MODULE, 'sources')?.map((s) => s.key);
const long = async (actor) => {
    Hooks.callAll('cosmere-rpg.rest', actor, 'long');
    await flush();
};

/** An effect that is not a table condition, with rules of its own. */
async function custom(actor, name, rules, data = {}) {
    const [effect] = await actor.createEmbeddedDocuments('ActiveEffect', [{ name, flags: { [MODULE]: { rules } }, ...data }]);
    await flush();
    return effect;
}

async function hudToggle(actor, id) {
    const existing = effectOf(actor, id);
    if (existing) await actor.deleteEmbeddedDocuments('ActiveEffect', [existing.id]);
    else {
        const effect = await CONFIG.ActiveEffect.documentClass.fromStatusEffect(id);
        await actor.createEmbeddedDocuments('ActiveEffect', [effect.toObject()], { keepId: true });
    }
    await flush();
}

/** Change links on table entries for the length of a test. */
async function withLinks(changes, fn) {
    const before = Object.fromEntries(Object.keys(changes).map((id) => [id, CONDITIONS_BY_ID[id].links]));
    for (const [id, links] of Object.entries(changes)) CONDITIONS_BY_ID[id].links = links;
    try {
        await fn();
    } finally {
        for (const [id, links] of Object.entries(before)) CONDITIONS_BY_ID[id].links = links;
    }
}

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

/* --- Links from any effect --- */

test('a custom effect with a link brings the condition with it and takes it away again', async () => {
    const actor = new FakeActor({ name: 'Kal', speed: 3 });
    const pinned = await custom(actor, 'Pinned', { links: ['immobilized'] });
    assert.deepEqual(statuses(actor), ['immobilized']);
    const child = effectOf(actor, 'immobilized');
    assert.deepEqual(child.getFlag(MODULE, 'sources'), [{ key: `effect:${pinned.id}`, label: 'Pinned' }]);
    assert.equal(actor.system.movement.walk.rate.value, 0, 'the condition does its usual work');

    await actor.deleteEmbeddedDocuments('ActiveEffect', [pinned.id]);
    await flush();
    assert.deepEqual(statuses(actor), []);
    assert.ok(env.chat.some((m) => m.content.includes('is no longer') && m.content.includes('Pinned ended')));
});

test('the linked condition cannot be removed by hand while the custom effect holds it', async () => {
    const actor = new FakeActor({ name: 'Shallan' });
    await custom(actor, 'Pinned', { links: ['immobilized'] });
    const before = env.warnings.length;
    await hudToggle(actor, 'immobilized');
    assert.ok(has(actor, 'immobilized'), 'still there');
    assert.match(env.warnings.slice(before).join('\n'), /Immobilized comes from Pinned/);
});

test('the child survives while something else holds it', async () => {
    // Applied by hand first: the custom effect adds itself as a source, and the hand-applied one stays.
    const a = new FakeActor({ name: 'Lift' });
    await api.apply(a, 'immobilized');
    const pinned = await custom(a, 'Pinned', { links: ['immobilized'] });
    assert.deepEqual(sourcesOf(effectOf(a, 'immobilized')), ['manual', `effect:${pinned.id}`]);
    await a.deleteEmbeddedDocuments('ActiveEffect', [pinned.id]);
    await flush();
    assert.ok(has(a, 'immobilized'), 'the hand-applied source keeps it');
    assert.deepEqual(sourcesOf(effectOf(a, 'immobilized')), ['manual']);

    // Two custom effects link to the same condition: it ends with the last one.
    const b = new FakeActor({ name: 'Teft' });
    const one = await custom(b, 'Pinned', { links: ['immobilized'] });
    const two = await custom(b, 'Webbed', { links: ['immobilized', 'slowed'] });
    assert.deepEqual(statuses(b), ['immobilized', 'slowed']);
    assert.equal(effectOf(b, 'immobilized').getFlag(MODULE, 'sources').length, 2);
    await b.deleteEmbeddedDocuments('ActiveEffect', [one.id]);
    await flush();
    assert.deepEqual(statuses(b), ['immobilized', 'slowed'], 'Webbed still holds both');
    await b.deleteEmbeddedDocuments('ActiveEffect', [two.id]);
    await flush();
    assert.deepEqual(statuses(b), []);
});

test('a custom effect that links to a condition with links of its own brings the chain', async () => {
    const actor = new FakeActor({ name: 'Renarin' });
    const pinned = await custom(actor, 'Knocked down', { links: ['prone'] });
    assert.deepEqual(statuses(actor), ['prone', 'slowed']);
    await actor.deleteEmbeddedDocuments('ActiveEffect', [pinned.id]);
    await flush();
    assert.deepEqual(statuses(actor), []);
});

test('effects without links, a disabled effect and a table condition\'s own override behave as before', async () => {
    const actor = new FakeActor({ name: 'Rock' });
    await custom(actor, 'Plain', { rolls: [{ who: 'self', mode: 'advantage', tests: 'all' }] });
    await custom(actor, 'Off', { links: ['immobilized'] }, { disabled: true });
    await actor.createEmbeddedDocuments('ActiveEffect', [{ name: 'No rules at all' }]);
    await flush();
    assert.deepEqual(statuses(actor), []);

    // Prone whose own rules say "no links" doesn't bring Slowed; one with its own list brings that list.
    const prone = await CONFIG.ActiveEffect.documentClass.fromStatusEffect('prone');
    await actor.createEmbeddedDocuments('ActiveEffect', [{ ...prone.toObject(), flags: { [MODULE]: { rules: { links: ['restrained'] } } } }], { keepId: true });
    await flush();
    assert.deepEqual(statuses(actor), ['prone', 'restrained']);
});

test('the engine switched off: a custom effect brings nothing', async () => {
    env.settings.set('enabled', false);
    try {
        const actor = new FakeActor({ name: 'Moash' });
        await custom(actor, 'Pinned', { links: ['immobilized'] });
        assert.deepEqual(statuses(actor), []);
    } finally {
        env.settings.set('enabled', true);
    }
});

test('"Rules on other effects" at remind: a custom effect\'s links only remind; off: nothing', async () => {
    env.settings.set('otherEffects', 'remind');
    try {
        const actor = new FakeActor({ name: 'Szeth' });
        const before = env.chat.length;
        await custom(actor, 'Mire', { links: ['immobilized', 'slowed'] });
        assert.deepEqual(statuses(actor), [], 'nothing applied');
        const lines = env.chat.slice(before).map((m) => m.content).join('\n');
        assert.match(lines, /Szeth.* has .*Mire/);
        assert.match(lines, /Also apply: Immobilized, Slowed\./);

        env.settings.set('otherEffects', 'off');
        const quiet = env.chat.length;
        await custom(actor, 'Webbed', { links: ['immobilized'] });
        assert.deepEqual(statuses(actor), []);
        assert.equal(env.chat.length, quiet, 'no line either');
    } finally {
        env.settings.set('otherEffects', 'full');
    }

    // A table condition's own links still follow the condition's setting, whatever "Rules on other effects" says.
    env.settings.set('otherEffects', 'off');
    try {
        const actor = new FakeActor({ name: 'Eshonai' });
        await hudToggle(actor, 'prone');
        assert.deepEqual(statuses(actor), ['prone', 'slowed']);
    } finally {
        env.settings.set('otherEffects', 'full');
    }
});

/* --- Loops --- */

test('a link loop through overridden rules stops with a warning', async () => {
    // The table checks itself for cycles when it loads; here the loop is made after that, as a rule override can.
    await withLinks({ slowed: ['prone'] }, async () => {
        const actor = new FakeActor({ name: 'Adolin' });
        const before = env.warnings.length;
        const consoleWarnings = await captureWarnings(() => hudToggle(actor, 'prone'));
        assert.deepEqual(statuses(actor), ['prone', 'slowed'], 'both applied once');
        assert.equal(sourcesOf(effectOf(actor, 'prone')), undefined, 'Prone (by hand) is not held by the Slowed it brought');
        assert.deepEqual(sourcesOf(effectOf(actor, 'slowed')), [`effect:${effectOf(actor, 'prone').id}`]);
        const shown = env.warnings.slice(before);
        assert.equal(shown.length, 1, shown.join('\n'));
        assert.match(shown[0], /Slowed would bring Prone, which is already being applied/);
        assert.equal(consoleWarnings.length, 1);

        // Nothing is stuck: removing Prone takes the Slowed it brought.
        await hudToggle(actor, 'prone');
        assert.deepEqual(statuses(actor), []);
    });
});

test('a loop that starts at a custom effect stops too', async () => {
    await withLinks({ slowed: ['prone'] }, async () => {
        const actor = new FakeActor({ name: 'Kaladin' });
        const before = env.warnings.length;
        const pinned = await custom(actor, 'Knocked down', { links: ['prone'] });
        assert.deepEqual(statuses(actor), ['prone', 'slowed']);
        assert.equal(env.warnings.slice(before).length, 1);
        await actor.deleteEmbeddedDocuments('ActiveEffect', [pinned.id]);
        await flush();
        assert.deepEqual(statuses(actor), []);
    });
});

test('a chain of links stops at the depth limit with a warning', async () => {
    await withLinks(
        { stunned: ['immobilized'], immobilized: ['restrained'], restrained: ['slowed'], slowed: ['prone'], prone: ['exhausted'], exhausted: [] },
        async () => {
            const actor = new FakeActor({ name: 'Lopen' });
            const before = env.warnings.length;
            await custom(actor, 'Root', { links: ['stunned'] });
            // The root is the first of six: stunned, immobilized, restrained, slowed and prone follow; Exhausted does not.
            assert.deepEqual(statuses(actor), ['immobilized', 'prone', 'restrained', 'slowed', 'stunned']);
            const shown = env.warnings.slice(before);
            assert.equal(shown.length, 1, shown.join('\n'));
            assert.match(shown[0], /too deep/);
        },
    );
});

/* --- Long rest --- */

test('a custom effect with longRest: 1 ends on a long rest', async () => {
    const actor = new FakeActor({ name: 'Sigzil' });
    await custom(actor, 'Fatigue', { longRest: 1 });
    await custom(actor, 'Untouched', {});
    await long(actor);
    assert.deepEqual(actor.effects.contents.map((e) => e.name), ['Untouched']);
    assert.ok(env.chat.some((m) => m.content.includes('Fatigue') && m.content.includes('has ended')));
});

test('a source holding a custom effect keeps it through a long rest, and it ends with the source', async () => {
    const injury = new FakeItem({ id: 'injury0000000001', name: 'Vicious Injury', type: 'injury', documentName: 'Item' });
    const actor = new FakeActor({ name: 'Arlo', items: [injury] });
    await custom(actor, 'Limp', { longRest: 1 }, { flags: { [MODULE]: { rules: { longRest: 1 }, sources: [{ key: 'item:injury0000000001', label: 'Vicious Injury' }] } } });
    await long(actor);
    assert.deepEqual(actor.effects.contents.map((e) => e.name), ['Limp'], 'held by the injury, it stays');
    assert.match(env.chat.at(-1).content, /stays .*Limp.* after the long rest \(from Vicious Injury\)/);

    actor.items.delete(injury.id);
    Hooks.callAll('deleteItem', injury, {}, game.user.id);
    await flush();
    assert.deepEqual(actor.effects.contents.map((e) => e.name), [], 'it ends with the injury');
});

test('a long rest leaves a custom effect alone when it is disabled, or when durations are off; remind only says so', async () => {
    const actor = new FakeActor({ name: 'Dalinar' });
    await custom(actor, 'Asleep', { longRest: 1 }, { disabled: true });
    await long(actor);
    assert.equal(actor.effects.contents.length, 1, 'disabled');

    const live = new FakeActor({ name: 'Navani' });
    await custom(live, 'Fatigue', { longRest: 1 });
    env.settings.set('durations', 'off');
    try {
        await long(live);
        assert.equal(live.effects.contents.length, 1, 'off');
        env.settings.set('durations', 'remind');
        const before = env.chat.length;
        await long(live);
        assert.equal(live.effects.contents.length, 1, 'remind changes nothing');
        assert.match(env.chat.slice(before).map((m) => m.content).join('\n'), /Fatigue.* ends/);
    } finally {
        env.settings.set('durations', 'full');
    }
    await long(live);
    assert.equal(live.effects.contents.length, 0, 'full');
});

test('a long rest still follows the condition\'s own setting and an override of the table\'s step', async () => {
    const actor = new FakeActor({ name: 'Teft' });
    await api.apply(actor, 'exhausted', { stacks: 2 });
    await flush();
    await long(actor);
    assert.equal(effectOf(actor, 'exhausted').system.stacks, 1, 'the table\'s step');

    // An Exhausted whose own rules say longRest: 0 is left alone.
    await effectOf(actor, 'exhausted').setFlag(MODULE, 'rules', { longRest: 0 });
    await long(actor);
    assert.equal(effectOf(actor, 'exhausted').system.stacks, 1);

    // A slowed effect given its own long-rest step ends (it does not stack: one step).
    await api.apply(actor, 'slowed');
    await effectOf(actor, 'slowed').setFlag(MODULE, 'rules', { longRest: 1 });
    await long(actor);
    assert.ok(!has(actor, 'slowed'));
});
