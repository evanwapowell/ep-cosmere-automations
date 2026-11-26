# Design: EP Cosmere Automations

A Foundry VTT module that automates rules of the **Cosmere RPG** system (`cosmere-rpg`) for Stormlight play, starting
with **real conditions**: conditions that change numbers and rolls, carry values, last for a set time, bring linked
conditions with them, remember their source, and end by themselves. The model is how the PF2e system handles
conditions.

- **Targets:** Foundry VTT v13 (verified 13.351), Cosmere RPG system 3.1.2. Works with the Stormlight Handbook module's
  content, and alongside the *Cosmere Advanced Encounters* (1.3.1) and *Cosmere Automated Actions* (1.3.1) modules.
- **Why:** the system treats conditions as markers. Prone, Restrained, Exhausted and the rest change nothing, nothing
  expires, and the GM applies every effect by hand. The system's own issue for this, #293 "Implement condition
  effects", is in its backlog with no date, so we build it here.
- **Who it's for:** any table using the system, played by hand. It also exposes an API that a GM helper module
  (`claude-gm-tools`) can call.
- **Status:** design only (2026-11-25). Nothing built yet.

## Ground rules

- **Public repo:** no campaign or adventure content, no rules text copied from the books (summaries in our own words),
  no credentials.
- **Every feature can be switched off.** Per condition: "full", "remind only" (a chat reminder, no changes) or "off".
  New features start in remind-only mode.
- **Small files, defensive hooks:** each layer in its own file; every hook handler wrapped in `try/catch` that logs and
  skips, so a system change disables one feature instead of breaking rolls.
- **Pure logic is testable without Foundry:** netting advantage against disadvantage, duration arithmetic, the
  condition table's validity and link resolution live in plain functions with no Foundry globals, tested with Node's
  built-in test runner (`node --test`). Foundry glue stays thin.

## System facts the design relies on (cosmere-rpg 3.1.2)

Read from the system source (GitHub: `the-metalworks/cosmere-rpg`, tag `release-3.1.2`; hooks in
`src/system/constants/hooks.ts`, actor in `src/system/documents/actor.ts`, data formats in `docs/Data-Formats.md`).
Re-check against the source when building.

**Conditions**
- Statuses are registered from `CONFIG.COSMERE.statuses` into `CONFIG.statusEffects` during the system's `init`.
  Each becomes an Active Effect with the fixed id `cond<status>` padded to 16 characters; the system counts an effect
  as a condition only with exactly that id and one status. So an actor holds one such effect per status; several
  Afflicted instances need separate effects with `statuses: ['afflicted']` and their own ids.
- Exhausted is the only stackable status (`system.isStackable`, `system.stacks`, name shows [−N]). The system's
  `CosmereActiveEffect.apply()` **multiplies every change of a stackable effect by its stack count**, after resolving
  roll-data formulas in the change value.
- 22 statuses: afflicted, blind, burrowing, depleted, determined, diminished, disoriented, empowered, enhanced,
  exhausted, flying, focused, hidden, immobilized, invisible, prone, restrained, slowed, stunned, surprised,
  unconscious, dead. Their config has no mechanical `changes`.
- Immunities: `system.immunities.condition.<status>` blocks toggling a status on; `system.immunities.damage.<type>` is
  honored in damage.

**Data an effect can change** (derived values are `value = base + bonus`, with `base` = `override` when
`useOverride`, computed when read):
`system.skills.<id>.mod.bonus`, `system.attributes.<id>.bonus` (note: also raises defenses),
`system.defenses.<phy|cog|spi>.bonus`, `system.deflect.bonus`, `system.movement.<walk|fly|swim>.rate.bonus /
.override / .useOverride`, `system.resources.<hea|foc|inv>.max.bonus`, `system.injuryRollBonus`.

**Rolls**
- A test or attack has one advantage mode: `'none' | 'advantage' | 'disadvantage'` (plus separate modes for the plot
  die and damage dice). Callers pass it as `advantageMode` to `item.use()` / `actor.rollSkill()`.
- `cosmere-rpg.pre<Context>Roll(roll, source, config)` (contexts `Skill`, `Item`, `Attack`) fires for every roll
  **before** evaluation; the `D20Roll` is already built, so set `roll.options.advantageMode` and call
  `roll.configureModifiers()` to rebuild the d20, or add terms. The source marks this argument "TEMP: Workaround".
- `cosmere-rpg.pre<Context>RollConfiguration` and `cosmere-rpg.preAttackRollConfiguration(options, item)` fire only
  when the roll dialog opens (not on fast-forward): use them to pre-select the dialog's buttons.
- `cosmere-rpg.skillRoll` / `attackRoll` fire **after** evaluation (too late to change the total).
- `cosmere-rpg.preDamageRoll(roll, source, config)` before a damage roll is evaluated.

**Damage, injuries, rest, items, combat**
- `actor.applyDamage([{amount, type}, …], {originatingItem})` sums all deflectable amounts, subtracts deflect once,
  then fires `cosmere-rpg.preApplyDamage(actor, damage)` (mutable `damage.calculated`) and `cosmere-rpg.applyDamage`.
- `actor.rollInjury()` rolls the injury tables; the card's Apply button creates an `injury` item, firing
  `cosmere-rpg.preApplyInjury` / `cosmere-rpg.applyInjury(message, actor, injuryItem)`. Nothing triggers it at 0 health.
- `cosmere-rpg.preRest` / `cosmere-rpg.rest`; `cosmere-rpg.combatRoundStart` / `combatRoundEnd`;
  `cosmere-rpg.preUseItem` / `useItem`.
- Item uses with `recharge: 'per_scene'` (e.g. Recover) are counted down but only recharged by hand (`item.recharge()`).
- Combat order: fast PCs → fast NPCs → slow PCs → slow NPCs; combatant flag `cosmere-rpg.turnSpeed`. With Advanced
  Encounters there is no current turn until a combatant's turn is started; it removes actions/reactions for Stunned,
  Surprised and Disoriented at turn start.

**Stances ("modality")**
- Stance talents have `system.modality: 'stance'`. Using one sets the actor flag `cosmere-rpg.mode.stance` to the
  talent's `system.id`, **enables that talent's own effects and disables the other stances' effects**
  (`actor.setMode`). The Stormlight Handbook's Stonestance carries `system.deflect.bonus +1`, Vinestance +1 Physical
  and Cognitive defense, Bloodstance −2 all defenses; Vigilant Stance, Flamestance, Windstance and Ironstance have
  effects with no changes. An "End Stance" talent exists.
- Nothing ends a stance at the end of the scene; the stance effect is non-temporary, so it shows on the sheet but not
  on the token; `actor.clearMode()` filters on the wrong field and is never called by the system (don't use it).

**Other modules**
- *Cosmere Automated Actions* has a "Let conditions modify rolls" setting (`automateConditions`) that appends the
  Exhausted penalty in the after-evaluation hooks (may not change totals: to verify), automates the Enhance action, and
  decrements Exhaustion. Avoid applying the same thing twice.
- No public module automates advantage, stances or reactions (survey 2026-11-23).

## Conditions engine

### What "real conditions" means (the PF2e model)

What PF2e does that Cosmere's system doesn't, and what we want:
1. **Mechanics:** a condition changes numbers (defenses, skills, speed) and rolls (advantage, penalties) by itself.
2. **Values:** Afflicted [3 keen], Enhanced [Strength +1], Exhausted [−2] carry their value; some stack.
3. **Durations:** set when applied, counted down, removed automatically, with a chat line when they end.
4. **Linked conditions:** Prone brings Slowed; Unconscious brings Prone. Removing the parent removes the children
   unless something else also applied them.
5. **Sources:** "Slowed (from Shallow Injury)" is removed when the injury heals; "Stunned (from a creature's ability)".
6. **Triggers:** Afflicted deals damage at the end of each turn; Determined offers itself when you fail a test.
7. **One way to apply them** for everyone: the token HUD, the sheet, chat buttons and Claude's API all go through the
   same path, so nothing is double-applied.

### What the system already gives us (the foundation)

From the system 3.1.2 source:
- Each status is a real **Active Effect** on the actor, created from `CONFIG.statusEffects` with the fixed id
  `cond<status>` (padded to 16 characters). The system treats an effect as "a condition" only with exactly that id and
  one status. Consequence: an actor can hold **one** effect per status this way. Several Afflicted instances must be
  separate effects with `statuses: ['afflicted']` and their own ids (the system won't call them conditions; our engine
  will).
- **Stacks are built in:** Exhausted is stackable (`system.stacks`, shown as [−N]), and the system's effect
  `apply()` **multiplies every change by the stack count**. So an Exhausted effect whose changes are "−1 to every skill"
  becomes −2 at two stacks with no extra code.
- **Effect keys:** every derived value has `value = base + bonus`, computed when read, with `bonus` and `override`
  fields effects can change: `system.skills.<id>.mod.bonus`, `system.attributes.<id>.bonus`,
  `system.defenses.<phy|cog|spi>.bonus`, `system.deflect.bonus`, `system.movement.<walk|fly|swim>.rate.bonus /
  .override / .useOverride`, `system.resources.<hea|foc|inv>.max.bonus`, `system.injuryRollBonus`. Change values may be
  roll-data formulas (the system resolves them first).
- **Immunities:** `system.immunities.condition.<status>` already blocks a condition from being toggled on.
- **Hooks** for rolls, damage, injuries, rests, item use and rounds (see "System facts" above), plus Foundry's own
  `createActiveEffect` / `deleteActiveEffect` / `updateActor` / combat hooks.
- Advanced Encounters already removes actions and reactions for Stunned, Surprised and Disoriented at turn start. The
  engine leaves that to it.

### Design: one table, five layers

1. **The condition table** (`data/conditions.js`, plain data). One entry per condition or
   situational effect: rule summary and source page, value type (none, number, damage type + amount, attribute + amount),
   stacking, effect changes, roll modifiers, default duration, linked conditions, triggers. Adding a talent later means
   adding an entry, not code. Being plain data also makes it something we could offer to the system later.
2. **Static mechanics through effect changes.** At `setup`, the engine adds `changes` to the system's
   `CONFIG.statusEffects` entries, so any newly toggled condition carries its mechanics, whoever toggles it. A one-time
   "refresh conditions" command updates condition effects already on actors (they were created without changes).
3. **Roll modifiers.** One roll handler collects advantages, disadvantages and penalties from the roller's and the
   target's effects (target = the roller's current target), nets advantages against disadvantages one for one
   (handbook ch. 9, "Advantages and Disadvantages"), sets the roll's mode and adds a line to the roll's flavor saying why. Hooks:
   `cosmere-rpg.preAttackRollConfiguration` / `preSkillRollConfiguration` (pre-select the dialog buttons so the player
   sees and can override them) and `cosmere-rpg.preAttackRoll` / `preSkillRoll` / `preItemRoll` for rolls without a
   dialog (`roll.options.advantageMode = …; roll.configureModifiers()`).
4. **Durations and expiry, with Cosmere's turn rules.** Foundry's built-in round/turn durations don't match Cosmere's
   fast/slow phases, and with Advanced Encounters there's no "current turn" until a combatant is started. So the
   engine stores its own duration in the effect's flags and checks it when Advanced Encounters starts or ends a turn and
   on the system's `combatRoundStart`. Duration kinds, all from the handbook (ch. 9, "Durations"):
   - *until the start of the same phase next round* (the default for round-based effects in combat);
   - *until the end of your next turn*; *after your next turn* (Surprised);
   - *end of scene* (combat end, or a GM "new scene" button);
   - *until a long rest* (system `rest` hook), *N days* (injuries; GM advances days);
   - *until used* (Determined, Dodge's mark); *until you move or attack* (Brace); *until removed* (default).
5. **Links, sources, values and the apply dialog.** When a condition is created from any path (`createActiveEffect`
   hook, on the GM's client), the engine adds linked conditions with a "from Prone" source, and, if the condition needs
   a value or the GM wants a duration, opens a small dialog (Afflicted: type and amount; Enhanced: attribute and amount;
   Exhausted: stacks; duration kind). When a parent ends, children it alone applied end too. A chat line says what
   started and ended ("Kal is Stunned until the start of the fast-PC phase next round"; GM-only option for NPCs).

Plus **triggers** for conditions that act at a moment: Afflicted damage at the end of the creature's turn (one
`applyDamage` per instance, typed); Determined offers a button on a failed test's card; Surprised blocks a fast turn
(the system's `turnSpeed` flag); Empowered refills Investiture at turn start (unless Automated Actions already does);
0 health sets Unconscious and posts the injury-roll button (see "The condition table").

**API for Claude** (`game.modules.get('ep-cosmere-automations').api`): `apply(actor, id, {value, duration,
source})`, `remove(actor, id)`, `list(actor)` (conditions with values, sources and time left), `mark(actor, 'dodge')`.
`claude-gm-tools` calls it when present and shows `list()` in `GM.turn()` and the perception views.

**Settings:** the engine on/off; per condition "full", "remind only" (chat reminder, no changes) or "off", so each
condition can be trusted one at a time and switched off the day the system implements it itself.

### The condition table

The 22 statuses the system defines, with the Stormlight rules summarized in our own words (handbook ch. 9–10).
"Layer" refers to "Design: one table, five layers".

| Status | Rule (short) | How the engine does it | Already handled |
| --- | --- | --- | --- |
| Afflicted [X type] | X damage at the end of each of your turns; several instances, each resolved separately | Value dialog (type, amount); one effect per instance; trigger at turn end | — |
| Determined | When you fail a test, add an Opportunity; then removed | Trigger: button on a failed test's card; duration *until used* | — |
| Disoriented | No reactions; senses obscured; disadvantage on Perception | Roll layer (Perception); reactions by Advanced Encounters | Advanced Encounters (reactions) |
| Empowered | Advantage on all tests; Investiture full at the start of each turn; ends at scene end | Roll layer; trigger at turn start (check Automated Actions first); *end of scene* | Maybe Automated Actions (check) |
| Enhanced [Attr +X] | +X to that attribute for skill tests, talents and movement, **not** defenses or max resources | Value dialog; changes on `skills.<id>.mod.bonus` for the attribute's skills (+ movement for Speed), not `attributes.<id>.bonus` (that would raise defenses) | Automated Actions automates the Enhance action (check how, so we don't double it) |
| Exhausted [−X] | −X on every skill test result; stacks; −1 per long rest | Changes: −1 on every skill's `mod.bonus` (system multiplies by stacks); rest hook reduces stacks | Automated Actions: "Let conditions modify rolls" may already do the penalty (test, section 2.6), and it decrements Exhaustion. Keep one, not both |
| Focused | Abilities that cost focus cost 1 less | Remind first; later reduce the cost in `preUseItem` (check the system's consume path) | — |
| Immobilized | Movement 0; can't move or be moved | Changes: movement override 0; refuse token moves (`preMoveToken`/`preUpdateToken`) with a GM override | — |
| Prone | Slowed; melee attacks against you gain an advantage; Brace without cover; standing up: free, then −5 ft until your next turn | Link → Slowed; roll layer (melee vs target); "Stand up" button adds a −5 ft effect *until the start of your next turn* | — |
| Restrained | Movement 0; disadvantage on all tests except escaping | Movement override 0; roll layer (the dialog shows it, so the player can drop it for an escape test) | — |
| Slowed | Movement halved | Change on `movement.<type>.rate.bonus` = minus half the current rate, set when applied (recomputed if Speed changes) | — |
| Stunned | Lose reactions; on your turn 2 fewer actions, no reaction | Duration only | Advanced Encounters |
| Surprised | Lose reactions; 1 fewer action; no fast turn; removed after your next turn | Duration *after your next turn*; block fast turn | Advanced Encounters (actions) |
| Unconscious | Movement 0, prone, drop held items, no actions or reactions; PC wakes at end of a turn or when healed | Link → Prone; movement override 0; reminder to drop held items; trigger at 0 health (with the injury roll) | — |
| Dead | — | Marker | — |
| Blind, Hidden, Invisible | Sense and stealth rules; tests against something you can't sense often gain a disadvantage | Leave to Foundry's vision and detection; optional roll-layer disadvantage vs a target the attacker can't see | Foundry core (vision) |
| Flying | Ranged attacks gain a disadvantage; knocked Prone while flying → you fall | Roll layer (ranged); trigger: Prone while Flying → falling reminder | — |
| Burrowing | Movement mode | Marker | — |
| Depleted, Diminished | Not in the Stormlight rules (other Cosmere settings) | Out of scope | — |

**Situational effects** use the same table and layers (not system statuses; the engine's own effects with an icon so
they show on the token):

| Effect | Rule | Engine |
| --- | --- | --- |
| Dodged | The attacker's next attack test against you gains a disadvantage | Created when Dodge is used (`useItem`); roll layer; *until used* |
| Bracing | Attacks against you gain a disadvantage while you stay behind cover | Created on Brace; *until you move or attack*; cover itself is the GM's call |
| Advantage gained | Gain Advantage: advantage on your next test against that target | *until used*, tied to the target |
| Stances | See "Stances" below | Marker + reminders; *end of scene* |
| Steady Aim | Extra damage on ranged hits = Perception ranks, until end of turn | Damage layer (`preDamageRoll`); *until the end of your turn* |
| Injuries | Exhausted / Slowed / Disoriented / Surprised / one hand, as long as the injury | On the system's `applyInjury` hook: offer the d8 table (the player chooses), add the condition with the injury item as its source; removed when the injury item is deleted |

### Stances (small, can come early)

Builds on the system's modality (see "System facts") rather than replacing it.
- When the flag `cosmere-rpg.mode.stance` changes, add a marker effect "Stance: Stonestance" with the talent's icon
  (shows on the token) and its rule summary; remove it when the stance ends.
- **End the stance** at the end of the scene: `actor.setMode('stance', <End Stance id>)`, or disable the stance
  effects directly. (The system's own `clearMode` has a bug and is never called; don't use it.)
- **Vigilant Stance's free switch:** refund the action Advanced Encounters spent, behind a setting, remind-only by
  default (it edits Advanced Encounters' private flags).
- **Reminders** when they matter: Stonestance (an enemy in reach attacking a non-Stonestance ally pays one extra
  action), Flamestance (exactly one enemy in reach: free action for an extra action), Vigilant Stance (Dodge and
  Reactive Strike cost 1 less focus). Flamestance's Intimidation advantage goes through the roll layer.
- A "repair stance effects" command adds the handbook's effect to a stance talent that lacks one.

### Later: Reactive Strike reminder

On token movement in combat, find hostile tokens whose melee reach the mover left without having used Disengage this
turn (Advanced Encounters records used actions) and whisper the GM (and the owner of a PC who could strike) "X left
Y's reach: Reactive Strike available". Reach comes from equipped weapons (same logic as `claude-gm-tools`
`perceptionFor`; copy, don't depend on it). Reminder only: the rules leave room for judgment.

### Phases

Each phase is a release that works on its own. Turn conditions on one at a time, starting in remind-only mode.

| Phase | Contents | Effort |
| --- | --- | --- |
| 0. Checks (no code) | In the world on a `zz` scene: does a toggled status keep `changes` added to `CONFIG.statusEffects`? Does Automated Actions' Exhausted setting change totals? How does Automated Actions apply Enhanced and Empowered? Does Advanced Encounters read the movement rate after effects? Does Foundry v13 remove expired effects by itself? | 1–2 h |
| 1. Core | Skeleton and settings; the condition table; static mechanics (Exhausted, Slowed, Immobilized, Restrained, Unconscious, Enhanced); links (Prone → Slowed, Unconscious → Prone); sources; apply dialog for values; chat lines; refresh command; API; **stances (4.5)** | 14–20 h |
| 2. Durations | The duration kinds, expiry on turn start/end, round start, combat end, rest; chat line on expiry; at the end of a scene also recharge per-scene item uses (Recover) | 7–12 h |
| 3. Roll layer | Advantage/disadvantage from conditions and situational effects (Dodge, Brace, Gain Advantage, Prone, Restrained, Empowered, Disoriented, Flying, Flamestance); flavor line; dialog pre-selection | 8–12 h |
| 4. Triggers | Afflicted ticks, Determined button, Surprised fast-turn block, Empowered refill, 0 health → Unconscious + injury roll + injury condition, Steady Aim damage, Focused cost | 10–14 h |
| 5. Reactive Strike reminder (4.6) | | 6–10 h |

The hours above are for a person writing the code. **With Claude Code writing it, the code for each phase takes one
session or two.** What takes real time is live testing in Foundry (a GM login and a `zz` test scene), the
owner's install of each release, and trying each condition in play. Phase 1 alone already fixes the most common
by-hand work (Exhausted, Slowed, stances on the token, injury conditions).

### Decisions taken and open

- **Changing the system's condition definitions** (layer 2) affects every condition toggled in the world from then on,
  and the refresh command edits effects already on actors. It's reversible (turn the module off and refresh again),
  but take a world backup first.
- **Automated Actions overlaps** on Exhausted (and maybe Enhanced/Empowered). For each, pick one owner: theirs if it
  works (phase 0 tells us), ours otherwise, and switch the other off.
- **Repo:** public. No campaign or adventure content in it, ever, and no rules text copied from the books: summaries in our own words only.
- **Later, optionally:** offer the condition table to the system (issue #293) once it has proven itself, so the
  system can take it over and the module shrinks.

## Risks with system updates

- **The system is young and changes fast** (3.0 → 3.1 in months). Pin `relationships.systems` to minimum `3.1.0`,
  verified `3.1.2`, and re-test after every system update before turning features on.
- **System 3.2.0 is close** (pre-release out). Its deflect refactor (#828) may change how Stonestance's
  `system.deflect.bonus` works, and its scene-ended and condition triggers (#654, #653) may make parts of the
  durations and triggers redundant. Read its release notes before phase 2 or anything touching deflect. The 4.0.0 roll
  refactor (#318) will likely break the roll layer: keep it in its own file and plan a rewrite then.
- **Condition internals:** the engine relies on the system's `cond<status>` effect ids, its stack multiplication in
  `apply()`, and adding `changes` to `CONFIG.statusEffects`. If the system implements #293 itself, each condition's
  setting lets us switch ours off one by one; the engine must check for system behavior before applying its own.
- **Roll hooks are marked "TEMP: Workaround"** in the system source (the roll object passed to `preAttackRoll`).
  Their arguments may change. Keep every hook handler in its own small file with a `try/catch` that logs and skips, so a
  change disables one feature instead of breaking rolls.
- **Modality is internal.** If the system later ends stances by itself or shows them on tokens, the stance feature must detect
  that and step back (check for the behavior, not the version number).
- **Advanced Encounters' flags** (`actionsUsed` etc.) are another module's private data. Touch them only in the stance
  free-switch refund, behind a setting, remind-only by default.
- **Double automation:** if a later system or Automated Actions release covers a feature, turn ours off. The settings
  make that a click.
- **Foundry v14** will need a compatibility pass (as for every module).


## Development

**Layout**

```
ep-cosmere-automations/
  module.json            // manifest
  data/conditions.js     // the condition table (plain data)
  scripts/main.js        // settings, hook registration
  scripts/logic/*.js     // pure functions, no Foundry globals (tested with node --test)
  scripts/*.js           // Foundry glue per layer: mechanics, durations, rolls, triggers, stances, api
  test/*.test.js         // node --test
  tools/release.sh       // bump version, tag, zip, GitHub release
```

**Manifest**

```json
{
  "id": "ep-cosmere-automations",
  "title": "EP Cosmere Automations",
  "version": "0.1.0",
  "compatibility": { "minimum": "13", "verified": "13.351" },
  "relationships": {
    "systems": [{ "id": "cosmere-rpg", "type": "system", "compatibility": { "minimum": "3.1.0", "verified": "3.1.2" } }],
    "recommends": [{ "id": "cosmere-advanced-encounters", "type": "module", "reason": "turn start/end events for durations" }]
  },
  "esmodules": ["scripts/main.js"],
  "url": "https://github.com/evanwapowell/ep-cosmere-automations",
  "manifest": "https://github.com/evanwapowell/ep-cosmere-automations/releases/latest/download/module.json",
  "download": "https://github.com/evanwapowell/ep-cosmere-automations/releases/download/v0.1.0/module.zip"
}
```

The release zip's top folder (or root) must match the id. A release script like `claude-gm-tools`' (`tools/release.sh`
there: bump `module.json`, tag, `git archive` the zip, publish a GitHub release with `module.json` and `module.zip`)
works here too.

**Testing**
1. `node --test` for the pure logic: every condition entry is valid; links resolve without cycles; advantage netting;
   each duration kind's expiry (phase order, fast/slow, round boundaries).
2. In Foundry, on a duplicate scene named `zz …` with test actors and GM-only rolls: load the code into the GM's
   browser console first, then install the release. Delete the scene and test chat messages afterwards. Never test on
   an active scene during play.
3. Turn on one condition at a time in play, in remind-only mode first.
