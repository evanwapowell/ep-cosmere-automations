# EP Cosmere Automations

A Foundry VTT (v13) module that automates rules of the Cosmere RPG system (`cosmere-rpg` 3.1.x) for Stormlight play,
starting with real conditions: conditions that change numbers and rolls, carry values, last for a set time, bring
linked conditions with them and end by themselves.

**Status:** 0.1.0 (phase 1) is written and unit-tested, but has not been tried in a live world yet. Don't use it in
a game until it has been tested on a throwaway scene. See [DESIGN.md](DESIGN.md).

## What 0.1.0 does

- **Conditions with mechanics:** Exhausted (−1 per stack on every skill), Slowed (half movement), Immobilized,
  Restrained and Unconscious (movement 0), Enhanced (+X to one attribute for skills and movement, not defenses).
- **Linked conditions:** Prone brings Slowed; Unconscious brings Prone. Removing the parent removes what it alone
  brought.
- **Values:** Afflicted asks for damage type and amount, Enhanced for attribute and amount; both can have several
  instances.
- **Stances:** using a stance's action switches the stance on (its effects apply) and shows it on the token.
- **Chat lines** when a condition starts or ends (NPC lines whispered to the GM).
- **Every feature can be switched off.** Each condition and stances have a setting: full, remind only (a chat
  reminder, no changes) or off. Everything starts in remind-only mode.

## API

```js
const api = game.modules.get('ep-cosmere-automations').api;
await api.apply(actor, 'afflicted', { value: { type: 'keen', amount: 3 } });
await api.apply(actor, 'exhausted', { stacks: 1 });
await api.apply(actor, 'slowed', { source: injuryItem }); // ends when the item is deleted
await api.remove(actor, 'prone');
api.list(actor); // [{ id, name, value, stacks, sources, from, active, mode }]
await api.endStance(actor);
```

## Development

`npm test` (or `node --test`) runs the tests: the pure logic, plus a smoke test of the Foundry glue against a small
fake Foundry. Release with `tools/release.sh <version>`.

Unofficial fan project; not affiliated with Brotherwise Games, Dragonsteel or The Metalworks.
