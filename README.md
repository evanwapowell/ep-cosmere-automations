# EP Cosmere Automations

A Foundry VTT (v13) module that automates rules of the Cosmere RPG system (`cosmere-rpg` 3.1.x) for Stormlight play,
starting with real conditions: conditions that change numbers and rolls, carry values, last for a set time, bring
linked conditions with them and end by themselves.

**Status:** conditions, durations and the advantage/disadvantage layer have had live passes in a real world
(Foundry 13.351, cosmere-rpg 3.1.2) on v0.3.1 to v0.3.6, and rules on effects (0.4.0) on 2026-11-27, with the one
fault found fixed in 0.4.1. Not yet checked live: anything that needs a player login (a player's attack using up an
NPC's Dodge through the GM relay, the Rules entry hidden from players) and two GMs at once. Everything starts in
remind-only mode; switch features to full one at a time. See "Live pass results" in [DESIGN.md](DESIGN.md).

## What it does

- **Conditions with mechanics:** Exhausted (−1 per stack on every skill), Slowed (half movement), Immobilized,
  Restrained and Unconscious (movement 0), Enhanced (+X to one attribute for skills and movement, not defenses).
- **Linked conditions:** Prone brings Slowed; Unconscious brings Prone. Removing the parent removes what it alone
  brought. As in PF2e, a condition something else holds (Slowed while Prone, an injury's Exhausted) can't be removed
  by hand until that source goes.
- **Values:** Afflicted asks for damage type and amount, Enhanced for attribute and amount; both can have several
  instances.
- **Stances:** using a stance's action switches the stance on (its effects apply) and shows it on the token.
- **Durations** with Cosmere's turn rules: until the start of this phase next round, the start or end of a
  creature's (next) turn, the end of the scene, a long rest, a number of days, or until used, whichever comes first.
  Turns follow Foundry's turn pointer as Cosmere Advanced Encounters moves it.
- **End of scene** (button in the token controls, or ending combat): scene-long effects and stances end, per-scene
  uses such as Recover recharge. A long rest removes one stack of Exhausted (the condition table's `longRest` field), but not the stacks an injury holds.
- **Advantage and disadvantage** from conditions (Restrained, Empowered, Disoriented; a Prone or Flying target) and
  from Dodge, Brace, Gain Advantage and Flamestance, and from any effect that carries roll rules of its own
  (setting "Rules on other effects"). Such a rule can say when it applies (`when: ['test:attack',
  'target:condition:prone']`, with `or` and `not`; see "Predicates on roll rules" in `DESIGN.md`). The roll dialog
  opens with it selected so the player can change it, and the chat card says why. Advantages and disadvantages
  cancel one for one.
- **Chat lines** when a condition starts or ends (NPC lines whispered to the GM).
- **Every feature can be switched off.** Each condition and stances have a setting: full, remind only (a chat
  reminder, no changes) or off. Rules carried by other effects (a talent's, a stance's, an item's or a homebrew
  effect's) follow one setting, "Rules on other effects". Everything starts in remind-only mode.

## Install

Foundry Setup → Add-on Modules → Install Module → Manifest URL:

    https://github.com/evanwapowell/ep-cosmere-automations/releases/latest/download/module.json

## API

```js
const api = game.modules.get('ep-cosmere-automations').api;
await api.apply(actor, 'afflicted', { value: { type: 'keen', amount: 3 } });
await api.apply(actor, 'exhausted', { stacks: 1 });
await api.apply(actor, 'slowed', { source: injuryItem }); // ends when the item is deleted
await api.apply(actor, 'stunned', { duration: 'endOfNextTurn' });
await api.apply(actor, 'immobilized', { duration: ['untilUsed', 'endOfScene'] }); // whichever comes first
await api.mark(actor, 'advantage', { target: enemy });   // Gain Advantage succeeded
api.modifiers(actor, { target: enemy, context: 'Attack', attackType: 'melee' }); // preview: { modifiers, mode, facts }
await api.endScene();          // the tokens on the viewed scene
await api.advanceDays(1);
await api.tie(actor, 'exhausted', injuryItem);          // an existing condition now lasts as long as the injury
await api.remove(actor, 'prone');
await api.remove(actor, 'slowed', { force: true });       // even while Prone holds it
api.list(actor); // [{ id, name, value, stacks, sources, from, active, mode }]
await api.endStance(actor);
```

## Give your own effects rules

Any Active Effect (a talent's, an item's, a homebrew one, or one of the module's conditions) can carry rules of its
own. As GM, open the effect's sheet and pick **Rules** in the header's controls menu: the dialog shows what the
effect does now and where each part comes from, and takes the effect's own rules as JSON. A field you set replaces
the default as a whole; a field you leave out keeps it. Save stays disabled while the rules have problems; "Reset to
defaults" takes the effect's own rules away. The schema is under "Rules on effects" in `DESIGN.md`.

A talent effect that gives advantage on Athletics tests:

```json
{ "rolls": [{ "who": "self", "mode": "advantage", "tests": { "skills": ["ath"] } }] }
```

A homebrew effect that halves movement and brings Slowed with it (links are followed when the effect is applied,
so set them before you put the effect on an actor):

```json
{ "mechanics": [{ "kind": "movement", "op": "half" }], "links": ["slowed"] }
```

The same through the API:

```js
api.rules(effect);                       // { rules, own, defaults, from: { mechanics: 'effect', … }, problems, … }
await api.setRules(effect, { mechanics: [{ kind: 'movement', op: 'half' }] }); // { ok, problems, rules }
await api.setRules(effect, null);        // back to the defaults
api.validateRules({ links: ['nope'] });  // ['links: unknown condition "nope"']
```

Rules on effects that are not conditions (their movement and skill changes, advantages and disadvantages, and the
conditions they bring) follow the setting "Rules on other effects"; in remind-only mode they change nothing and the
chat says what they would have done.

## Development

`npm test` (or `node --test`) runs the tests: the pure logic, plus a smoke test of the Foundry glue against a small
fake Foundry. Release with `tools/release.sh <version>` (bumps, tags, pushes), or Actions → Release → Run workflow
with a branch and a version; the Release workflow tests, builds `module.zip` and publishes the GitHub release.
Releases are cut from `main` only: the script refuses to run anywhere else, and the workflow refuses any commit that is
not on `main`.

Unofficial fan project; not affiliated with Brotherwise Games, Dragonsteel or The Metalworks.
