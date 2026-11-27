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
- **Status:** phases 1–3 written (2026-11-26) and given a first live pass (Foundry 13.351, cosmere-rpg 3.1.2,
  Stormlight Handbook data, Advanced Encounters, Automated Actions): 19 of 21 checks pass on v0.3.1 after six
  fixes; two need a second login. See "Live pass results" below and the "Phase 1/2/3 as built" sections.
  0.3.2 and 0.3.3 added the rules in "After the live pass" and "Held conditions"; 0.3.4 moved the long-rest step
  into the table.

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
`system.skills.<id>.mod.bonus`, `system.attributes.<id>.bonus` (feeds skill modifiers, walking speed, senses
range and lifting capacity; **not** defenses, which sum `attributes.<id>.value` only, and not max resources, whose
formulas read `@attr.<id>` = `value` only; source checked 2026-11-26),
`system.defenses.<phy|cog|spi>.bonus`, `system.deflect.bonus`, `system.movement.<walk|fly|swim>.rate.bonus /
.override / .useOverride`, `system.resources.<hea|foc|inv>.max.bonus`, `system.injuryRollBonus`.

**Rolls**
- A test or attack has one advantage mode: `'none' | 'advantage' | 'disadvantage'` (plus separate modes for the plot
  die and damage dice). Callers pass it as `advantageMode` to `item.use()` / `actor.rollSkill()`.
- `cosmere-rpg.pre<Context>Roll(roll, source, config)` (contexts `Skill`, `Item`, `Attack`) fires for every roll
  **before** evaluation; the `D20Roll` is already built, so set `roll.options.advantageMode` and call
  `roll.configureModifiers()` to rebuild the d20, or add terms. The source marks this argument "TEMP: Workaround".
- `cosmere-rpg.pre<Context>RollConfiguration` and `cosmere-rpg.preAttackRollConfiguration(options, item)` fire only
  when the roll dialog opens (not on fast-forward).
- **The skill/item roll dialog ignores the roll's mode** (source checked 2026-11-26): `d20Roll` builds the roll,
  fires `pre<Context>Roll`, then calls `roll.configureDialog({skillTest: {data, parts}})` without an
  `advantageMode`; the dialog starts at "none" and its result **overwrites** `roll.options.advantageMode`. So a
  mode set in `preSkillRoll` survives only fast-forwarded rolls. Changing `config` in `preSkillRollConfiguration`
  doesn't reach the dialog either.
- **The attack dialog does start from `options.skillTest.advantageMode`**, which
  `preAttackRollConfiguration(options, item)` can set. After it, the attack's test is rolled with
  `configurable: false`, so `preAttackRoll` fires again for the same attack (with the dialog's result).
- Roll contexts: `Skill` (source = actor), `Item` and `Attack` (source = item; `data.skill.id` set). An item's
  test includes the skill's `mod.bonus` even with another attribute. Attack type: `item.system.attack.type`
  (`melee` / `ranged`). Basic action ids: `dodge` (reaction), `brace`, `gain_advantage`.
- `cosmere-rpg.skillRoll` / `attackRoll` fire **after** evaluation (too late to change the total).
- **The attack hooks get a "Strike: X" action, not the weapon** (live 2026-11-25): a character's is an item embedded
  in the equipped weapon (attack type on the parent weapon); an adversary's is a plain action with no attack data
  ("Reach 5 ft." / "Range 80/120 ft." in its description). Both go through `preAttackRollConfiguration`.
- **The chat card is rebuilt after `renderChatMessageHTML`**: the system's `renderHTML` replaces `.message-content`
  with its own card for messages with a system type; add things beside it, not inside.
- `cosmere-rpg.preDamageRoll(roll, source, config)` before a damage roll is evaluated.
- `actor.rollSkill()` uses `skill.mod.value` (so `mod.bonus` counts), **except** when the test is rolled with
  another attribute (`options.attribute`): then it sums that attribute's `value + bonus` and the skill rank, and the
  skill's `mod.bonus` is skipped.

**Order of data preparation** (`CosmereActor.prepareDerivedData`): Foundry's derived step, then
`applyActiveEffects()`, then `system.prepareSecondaryDerivedData()`, which computes walking speed from Speed,
defenses, skill modifiers and deflect. So effects run **before** walking speed and skill modifiers exist; anything
that depends on them ("half your movement") has to run after this method.

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
- A granted action records the talent that granted it in `system.relationships` (`{type: 'parent', itemType,
  uuid}`), written by the system's GrantItems event handler.
- Stance talents have `system.modality: 'stance'`. `actor.setMode('stance', talent.system.id)` sets the actor flag
  `cosmere-rpg.mode.stance`, **enables that talent's own effects and disables the other stances' effects** (verified
  live 2026-11-25: Stonestance deflect +1, then back).
- **But using a stance from the sheet never calls it** (verified live, system 3.1.2 with the Stormlight Handbook data):
  talents can't be used themselves (`item.use()` returns null for a talent); the activation cost sits on a nested
  *action* the talent grants, with a different id (e.g. `stone-stance` vs the talent's `stonestance`) and no modality,
  and using that action only posts a chat card. The flag stays unset and every stance effect stays disabled. The
  system's own mode activation only runs for items that have both an id and a modality. The Stormlight Handbook's Stonestance carries `system.deflect.bonus +1`, Vinestance +1 Physical
  and Cognitive defense, Bloodstance −2 all defenses; Vigilant Stance, Flamestance, Windstance and Ironstance have
  effects with no changes. An "End Stance" talent exists.
- Nothing ends a stance at the end of the scene; the stance effect is non-temporary, so it shows on the sheet but not
  on the token; `actor.clearMode()` filters on the wrong field and is never called by the system (don't use it).
- **A mode flag can't be unset** (live 2026-11-25): `unsetFlag('cosmere-rpg', 'mode.stance')` throws, because the
  system's `preUpdateActor` treats `-=stance` as a modality name. `actor.setMode('stance', null)` works and disables
  every stance effect.
- In the Stonewalkers world the stance talents grant no separate stance action: the sheet lists the talent under
  "Miscellaneous Actions", and its use control does nothing (`item.use()` is null for non-actions).
- An effect with exactly one status must be created with a chosen `_id` and `keepId: true`: the system's
  `_preCreate` reads `this.id.startsWith(...)` (live 2026-11-25).

**Turns and rounds**
- The system's combat calls `cosmere-rpg.combatRoundStart` / `combatRoundEnd` from `startCombat` / `nextRound` on
  the GM's client. Its own tracker marks a combatant as having acted with the flag `cosmere-rpg.activated`; it does
  not move Foundry's turn pointer.
- *Advanced Encounters* 1.3.1 (source: `posadist-revolution/cosmere-advanced-encounters`) moves the pointer:
  "activate" on a combatant sets `combat.turn` to it (a turn starts) and marks it activated; "next turn" sets
  `turn: null` (the turn ends); a new round first sets `turn: null`, then advances the round. So in AE, `activated`
  means "has started its turn", not "has finished".
- Phase order comes from the combatant's initiative getter: `turnSpeed` fast +1000, characters +500 → fast PC, fast
  NPC, slow PC, slow NPC. A boss gets a second, fast combatant.
- `actor.longRest()` fires `cosmere-rpg.rest(actor, 'long')` and leaves "reduce Exhausted by 1" as a TODO.
  Per-scene uses (`system.resources.<uses|charges|ammo>.recharge === 'per_scene'`) are recharged by `item.recharge()`
  only when someone calls it.

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
2. **Static mechanics.** *(Changed while building phase 1; see "Phase 1 as built".)* Two kinds:
   - *Derived adjustments*, for mechanics that depend on derived values or stacks (movement 0, half movement,
     Exhausted): the engine wraps the actor's `prepareDerivedData` and, after the system's own derivation, adjusts
     `movement.<type>.rate.bonus` and `skills.<id>.mod.bonus` for the conditions the actor has. Nothing is stored,
     so there is nothing to refresh, settings take effect at once, and turning the module off undoes it.
   - *Effect changes*, for mechanics that come from a value: Enhanced writes `system.attributes.<id>.bonus +X` on
     its own effect when created (from the API, or after the value dialog).
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
| Enhanced [Attr +X] | +X to that attribute for skill tests, talents and movement, **not** defenses or max resources | Value dialog; change on `attributes.<id>.bonus`, which in the system feeds skills, movement and senses but not defenses or max resources (see "System facts") | Automated Actions automates the Enhance action (check how, so we don't double it) |
| Exhausted [−X] | −X on every skill test result; stacks; −1 per long rest | Derived adjustment: −stacks on every skill's `mod.bonus`; rest hook reduces stacks (phase 2) | Automated Actions: "Let conditions modify rolls" may already do the penalty (test, section 2.6), and it decrements Exhaustion. Keep one, not both |
| Focused | Abilities that cost focus cost 1 less | Remind first; later reduce the cost in `preUseItem` (check the system's consume path) | — |
| Immobilized | Movement 0; can't move or be moved | Changes: movement override 0; refuse token moves (`preMoveToken`/`preUpdateToken`) with a GM override | — |
| Prone | Slowed; melee attacks against you gain an advantage; Brace without cover; standing up: free, then −5 ft until your next turn | Link → Slowed; roll layer (melee vs target); "Stand up" button adds a −5 ft effect *until the start of your next turn* | — |
| Restrained | Movement 0; disadvantage on all tests except escaping | Movement override 0; roll layer (the dialog shows it, so the player can drop it for an escape test) | — |
| Slowed | Movement halved | Derived adjustment: every movement rate halved (rounded down) after everything else, so it follows Speed changes | — |
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
- **Make stances actually activate:** on `cosmere-rpg.useItem`, when the used action belongs to a talent with
  `system.modality` (the action's parent talent, or the talent that grants it: check how the nested action links back),
  call `actor.setMode(modality, talent.system.id)`. Same for singer forms (`modality: 'singer-form'`). This is the
  core of the feature; without it nothing below happens.
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

### Granted buffs: one character gives another a bonus that a test uses up (e.g. Decisive Command)

Talents where one character spends an action or focus to give another a bonus, which ends when that character's next
test uses it, or when time runs out. The model case is the Leader's **Decisive Command** (from the system's own Leader
data, `packs/heroic-paths/leader/decisive-command.json`): 1 action and 1 focus; choose an ally you can influence
within 20 ft; the next time they make a test before the end of their next turn, they roll your command die (a d4 to
start) with the test and may add it to one die from that test other than the plot die. The talent carries no effects,
so nothing happens today.

Related, same die: **Confident Command** (Officer) and **Demonstrative Command** (Champion) let the leader spend 1
focus before certain skill tests (Intimidation, Leadership, Persuasion; Athletics, Agility, Leadership) to add the
command die to their own d20. Other Leader talents use the die in other ways.

What it needs, beyond what the plan already has:
1. **Applying an effect to another player's actor.** Phase 1 does all work on the client of the user who acted,
   which only ever touches their own actor. A player cannot create effects on another player's character, so a
   granted buff goes through the **GM relay** (built in phase 3 for using up a target's Dodging): the acting client
   sends a socket request (`module.ep-cosmere-automations`) and the active GM's client creates the effect, after
   checking the request (the sender owns the granting actor, the target is a valid actor, the buff is in the table).
   The relay gains a second request type, "grant".
2. **Combined durations ("whichever comes first"):** *until used* **or** *until the end of the target's next turn*.
   Durations are a list of kinds, and the first one to trigger ends the effect (built in phase 2).
3. **Adding a die, not advantage.** In the roll layer, a `preSkillRoll` / `preAttackRoll` handler on the roller's
   client finds the buff, adds the die as a term (flavor: "Command die from Dalinar"), and marks the buff used; the
   effect is deleted after the roll (`skillRoll` / `attackRoll`). The roller owns their own actor, so no relay is
   needed to use it up. "Add it to one die of your choice": on a plain skill test the only non-plot die is the d20,
   so adding the term to the total gives the same result. When the test has other dice the player could pick, the
   chat card says so and the GM adjusts; no automation of that choice.
4. **The command die's size lives with the leader**, since the system stores it nowhere (it is only in the talent's
   text): an actor flag `commandDie` (default `d4`), shown and editable from the API (`setCommandDie(actor, 'd6')`)
   and later from the sheet. The buff copies the die size when given, so a later change doesn't alter a buff already
   handed out.
5. **Giving it:** on `cosmere-rpg.useItem` for the Decisive Command action (matched by id like stances), take the
   user's current target as the ally (warn when there is none or more than one; check the 20 ft distance and leave
   "can influence" to the players), spend nothing extra (the system already charged the focus), and send the relay
   request. In remind-only mode: a chat line "Kal has Dalinar's command die (d4) for their next test".
6. **Self-use talents** (Confident/Demonstrative Command): a checkbox in the roll dialog via
   `preSkillRollConfiguration` ("Spend 1 focus: add command die") for the listed skills, spending the focus when ticked.
   Remind-only first: a chat reminder on those skill tests.

Table entries (situational effects, not system statuses): `commandDie` (value: die size and giver; duration:
`untilUsed` + `endOfNextTurn`; roll layer: add die to the next test). Build order: after the roll layer (phase 3), with
the GM relay; rough effort 4–8 h of code, plus a live test with two player logins (to prove the relay).

### Later: Reactive Strike reminder

On token movement in combat, find hostile tokens whose melee reach the mover left without having used Disengage this
turn (Advanced Encounters records used actions) and whisper the GM (and the owner of a PC who could strike) "X left
Y's reach: Reactive Strike available". Reach comes from equipped weapons (same logic as `claude-gm-tools`
`perceptionFor`; copy, don't depend on it). Reminder only: the rules leave room for judgment.

### Phases

Each phase is a release that works on its own. Turn conditions on one at a time, starting in remind-only mode.

| Phase | Contents | Effort |
| --- | --- | --- |
| 0. Checks (no code) | In the world on a `zz` scene: does Automated Actions' Exhausted setting change totals? How does Automated Actions apply Enhanced and Empowered? Do Advanced Encounters and the token ruler read `movement.walk.rate.value` (so Slowed and Immobilized show up there)? Does Foundry v13 remove expired effects by itself? *(The question "does a toggled status keep changes added to `CONFIG.statusEffects`" no longer matters: phase 1 doesn't use that.)* | 1–2 h |
| 1. Core | Skeleton and settings; the condition table; static mechanics (Exhausted, Slowed, Immobilized, Restrained, Unconscious, Enhanced); links (Prone → Slowed, Unconscious → Prone); sources; apply dialog for values; chat lines; API; **stances (4.5)** | 14–20 h (code written: see "Phase 1 as built") |
| 2. Durations | The duration kinds, expiry on turn start/end, round start, combat end, rest; chat line on expiry; at the end of a scene also recharge per-scene item uses (Recover) | 7–12 h (code written: see "Phase 2 as built") |
| 3. Roll layer | Advantage/disadvantage from conditions and situational effects (Dodge, Brace, Gain Advantage, Prone, Restrained, Empowered, Disoriented, Flying, Flamestance); flavor line; dialog pre-selection | 8–12 h (code written: see "Phase 3 as built") |
| 4. Triggers | Afflicted ticks, Determined button, Surprised fast-turn block, Empowered refill, 0 health → Unconscious + injury roll + injury condition, Steady Aim damage, Focused cost | 10–14 h |
| 5. Reactive Strike reminder (4.6) | | 6–10 h |
| 3b. Granted buffs | GM relay (socket); Decisive Command (give, use up on the next test, expire at end of next turn); command die size; Confident/Demonstrative Command reminders, then dialog checkbox | 4–8 h |

The hours above are for a person writing the code. **With Claude Code writing it, the code for each phase takes one
session or two.** What takes real time is live testing in Foundry (a GM login and a `zz` test scene), the
owner's install of each release, and trying each condition in play. Phase 1 alone already fixes the most common
by-hand work (Exhausted, Slowed, stances on the token, injury conditions).

### Decisions taken and open

- **The system's condition definitions are left alone** (changed in phase 1): mechanics are computed live
  (derived adjustments), so nothing in `CONFIG.statusEffects` changes and no refresh command is needed. The only
  stored mechanic is Enhanced's change on its own effect. Turning a condition off stops its derived adjustment at
  once; an Enhanced effect created in full mode keeps its change until it is removed.
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
- **Condition internals:** the engine relies on the system's `cond<status>` effect ids, `system.stacks`, the
  `bonus` fields of derived values, and the order inside `CosmereActor.prepareDerivedData`. If the system implements #293 itself, each condition's
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


## Phase 1 as built (0.1.0)

What the code does, and where it differs from the plan above.

- **Files:** `data/conditions.js` (the table), `scripts/logic/*` (pure: table checks and links, sources, values,
  derived adjustments, stance lookup), `scripts/mechanics.js` (derived adjustments; Enhanced's change on create),
  `scripts/conditions.js` (links, sources, chat lines, value dialog trigger), `scripts/values.js` (dialog),
  `scripts/stances.js`, `scripts/api.js`, `scripts/settings.js`, `scripts/main.js`.
- **Conditions automated:** Exhausted (−stacks on every skill), Slowed (half movement), Immobilized, Restrained and
  Unconscious (movement 0), Enhanced (attribute bonus), links Prone → Slowed and Unconscious → Prone, values for
  Afflicted and Enhanced (dialog from the HUD or sheet, or `value` in the API), several Afflicted or Enhanced
  instances (each its own effect, with an id that still starts with `cond<status>` so the system lists it).
- **Sources:** stored on the effect as `[{key, label}]` with keys `manual`, `effect:<id>` or `item:<id>`. After any
  effect or item is deleted, the engine drops sources that no longer exist and ends conditions left with none. It
  looks at what is present rather than at what was just deleted, so deleting several things at once gives the same
  result; work is queued per actor.
- **Who does the work:** the client of the user who created or deleted the effect (they have permission on the
  actor). No socket, no GM needed.
- **Every condition with a setting starts in remind-only mode**, as do stances. Remind mode posts the rule summary
  (and "Also apply: Slowed" for links) and changes nothing.
- **Stances:** on `cosmere-rpg.useItem`, the talent behind the used action is found by the action's `parent`
  relationship, falling back to matching ids (`stone-stance` ↔ `stonestance`), and `actor.setMode` is called. A
  marker effect "Stance: X" (status `ep-stance`, so it shows on the token) follows the actor's stance flag.
  `api.endStance(actor)` switches to the End Stance talent if the actor has it, else clears the flag and disables the
  stance effects itself.
- **API:** `apply(actor, id, {value, stacks, source})`, `remove(actor, id, {source})`, `list(actor)`,
  `endStance(actor)`, `syncStanceMarker(actor)`, `cleanupSources(actor)`. `source` may be an item or effect on the
  actor (the condition then ends with it), a string, or `{key, label}`.
- **Known gaps, for later phases:** no durations yet; Afflicted's damage, Determined and the other triggers are not
  automated (Afflicted's damage: done in 0.3.2, see "After the live pass"); Exhausted does not reach a skill test
  rolled with another attribute (see "System facts"; done in 0.3.2); Restrained's
  disadvantage and Prone's melee advantage wait for the roll layer; "Stand up" and the falling reminder are not built.
- **To try live** (on a `zz` scene, one condition at a time, set to full): toggle Prone from the HUD (Slowed appears,
  walking speed halves, both go when Prone is removed); Unconscious (chain of three, movement 0); Exhausted with 2
  stacks (skill modifiers −2 on the sheet and in a roll); Enhanced Speed +1 (skills and movement go up, defenses
  don't); Afflicted from the HUD (dialog, name shows the value); a stance action with stances set to full (stance
  effects switch on, the marker appears on the token).

## Phase 2 as built (durations)

- **A duration is a list of kinds; the first to trigger ends the effect.** Kinds: `phaseNextRound` (until the start
  of the same phase next round), `startOfNextTurn`, `endOfTurn`, `endOfNextTurn` (a turn that starts after the effect
  was applied; the turn in progress doesn't count), `endOfScene`, `longRest`, `days`, `untilUsed`. "After your next
  turn" (Surprised) is `endOfNextTurn`. Stored in the effect's flags with the actor whose turns count (`turnOf`,
  default the affected actor; a granted buff can count the giver's turns) and the round and phase it was applied in.
  Pure logic in `scripts/logic/durations.js`.
- **Turn-based kinds also end when the encounter or scene ends**, so nothing outlives the fight waiting for a turn
  that won't come. `phaseNextRound` applied outside combat becomes `endOfScene`.
- **Events:** the active GM's client watches the combat's turn pointer (`updateCombat` on `turn` / `round`),
  compares it with the last pointer it saw and turns the difference into turn end, round start and turn start.
  This follows Advanced Encounters' pointer as well as plain Foundry turn order. Deleting a combat ends combat
  durations and, by default, the scene for its combatants. Long rest: `cosmere-rpg.rest` on the resting client.
- **Without Advanced Encounters**, the system's own tracker doesn't move the pointer, so turn-based durations only
  tick if the GM uses Foundry's turn order; round-based ones still tick on round changes.
- **End of scene** (a GM button in the token controls, `api.endScene()`, or ending an encounter): effects lasting
  until the end of the scene end, stances end (`endStance`), per-scene uses recharge. Each follows its setting.
- **Long rest:** effects lasting until a long rest end, and each condition whose table entry has `longRest: n`
  loses n free stacks (one ends a condition that doesn't stack). Only Exhausted has it (`longRest: 1`); it follows
  the condition's own setting. A step another module already does is skipped (`longRestDoneElsewhere` in
  settings.js: Automated Actions' "decrementExhaustion"); turn that off to leave it to this module.
- **Setting the duration:** the API's `duration` option; else the table's default (Surprised: end of next turn;
  Empowered: end of scene; Determined: until used); and when a condition is turned on from the token or sheet during
  combat (setting: during combat / always / never), the same dialog as for values asks how long it lasts.
- **Modes:** durations full / remind / off (remind by default). Remind posts "Kal's Stunned ends now" once and stops
  tracking; the effect stays.
- **API:** `apply(…, {duration})`, `setDuration(effect, spec)`, `endScene({actors})`, `advanceDays(n, {actors})`,
  `use(effect)` (ends an "until used" effect; the roll layer and triggers will call it), and `list()` gains
  `duration` and `lasts` (readable text).
- **Stunned and Surprised** now have settings (their action loss stays with Advanced Encounters).
- **Not built:** Surprised's "no fast turn" (built in 0.3.2), Foundry's own effect durations are not used, a
  per-day clock (days only advance through the API).
- **To try live** (durations set to full, Advanced Encounters on): Stunned applied during Kal's turn with "until the
  end of its next turn" survives that turn and ends at the end of Kal's next one; Restrained with "until the start of
  this phase next round" during a slow PC turn ends when the first slow PC starts next round; Surprised on an NPC at
  the start of combat ends after its first turn; End Combat ends a stance and refills Recover; a long rest takes one
  Exhausted stack. Check that only one chat line appears per event with two GMs logged in.

## Phase 3 as built (roll layer)

- **Rules are data:** conditions carry `rolls: [{who: 'self' | 'target', mode, tests}]` with `tests` = `all`,
  `attack`, `melee`, `ranged` or `{skills: [...]}`. Restrained (self, all, disadvantage), Empowered (self, all,
  advantage), Disoriented (self, Perception, disadvantage), Prone (target, melee, advantage), Flying (target, ranged,
  disadvantage). Situational effects live in `data/situational.js`: Dodging (target, attacks, disadvantage, used
  up; until used or the end of the current turn), Bracing (target, attacks, disadvantage; ends when the bracer
  attacks or moves; "only from the other side of the cover" is the GM's call, through the dialog), Advantage gained
  (self, any test against the stored enemy, used up), Flamestance (Intimidation advantage while in the stance).
- **Netting:** the caller's own choice (shift-click, macro) counts as one; each active modifier adds or removes
  one; the sign decides the mode. Several instances of one condition count once.
- **Target:** the roller's single targeted token (none or several: target-side rules are skipped).
- **Reaching the dice:** `pre<Skill|Item|Attack>Roll` sets the mode and calls `roll.configureModifiers()`;
  `D20Roll.prototype.configureDialog` is wrapped to pass that mode to the dialog as its starting value (the player
  sees it selected and can change it, e.g. Restrained on an escape test); attacks are pre-selected in
  `preAttackRollConfiguration`, and the following `preAttackRoll` only records the note (only for a dialog the
  player submitted within the last minute, so a cancelled dialog doesn't affect the next fast-forwarded attack).
- **The card:** the roll carries `options['ep-cosmere-automations'].note` ("Advantage: target Prone. Disadvantage:
  Restrained."), shown at the top of the chat card by a `renderChatMessageHTML` handler.
- **Using up:** after the roll (`<skill|item|attack>Roll`), effects used by it are deleted, through the **GM relay**
  (module socket, `"socket": true`) when the roller doesn't own them (a player's attack using up an NPC's
  Dodging). The GM side accepts only "use up this situational effect that has a used-up rule".
- **Action effects:** using Dodge or Brace puts Dodging / Bracing on the user's token. Gain Advantage needs one
  target and posts a card with a "The test succeeded" button; the button (for the actor's owners) creates Advantage
  gained against that enemy.
- **Modes:** "Advantage and disadvantage on tests" full / remind / off (remind by default: the card lists what
  would apply, the roll is unchanged); a condition's modifiers also need that condition's own setting at full.
  "Effects from Dodge, Brace and Gain Advantage" full / remind / off (remind by default).
- **API:** `mark(actor, 'dodging' | 'bracing' | 'advantage', {target, duration})`, `marks(actor)`,
  `modifiers(actor, {target, context, skill, attackType})` (preview without rolling).
- **Not built / known gaps:** Gain Advantage's "a different skill from the test that gained it" is shown in the
  effect's text, not enforced; an advantage is always put on the d20 (the rules also allow the plot die: the player
  can move it in the dialog). (Blind/Hidden/Invisible roll rules and Exhausted on another attribute: added in 0.3.2,
  see "After the live pass".)
- **To try live** (rolls and action effects set to full; Restrained, Prone set to full): a Restrained character's
  Athletics test opens with disadvantage selected; a sword attack on a Prone target opens with advantage, a bow
  attack doesn't; a player's attack on an NPC who used Dodge rolls with disadvantage and removes Dodging (GM logged
  in, player attacking); Brace then move the token: Bracing ends; Gain Advantage with a target, press the button,
  then a test against that target has an advantage once; the chat card shows the reason line.

## Live pass results (2026-11-25/26)

First run in a real world, following `docs/LIVE-PASS.md`: Foundry 13.351, cosmere-rpg 3.1.2, Stormlight Handbook
content, Cosmere Advanced Encounters 1.3.1 and Cosmere Automated Actions 1.3.1 active, GM user only. Test scene
`zz live pass` with `zz Kal`, `zz Shallan` (characters) and `zz Brute` (an adversary from the world guide); all
deleted afterwards with their chat messages, and the module's settings put back to remind-only. Started on
v0.3.0; the fixes below were released as **v0.3.1** and every failed check was re-run on it.

**Checks**

| # | Result | Seen |
|---|--------|------|
| 1 | pass | Prone from the token's status toggle: Slowed follows ("from Prone"), walking speed 30 → 15; removing Prone removes both. One chat line each. |
| 2 | pass | Unconscious → Prone → Slowed, movement 0; all three end together. |
| 3 | pass | Exhausted, then 2 stacks: every skill modifier −2, the effect is named "Exhausted [-2]", a fast-forwarded Athletics total agrees. (See Automated Actions below for the formula.) |
| 4 | pass | `apply(kal, 'enhanced', {value: {attribute: 'spd', amount: 2}})`: "Enhanced [Speed +2]", Speed skills 3 → 5, walking 30 → 40, Physical defense unchanged. |
| 5 | pass | Afflicted from the Token HUD opens the dialog (damage, type); "Afflicted [3 Energy]". |
| 6 | **fail → fixed** | Using Stonestance on the sheet did nothing (see fix 1); ending a stance threw (fix 2); the marker could not be created (fix 3). On v0.3.1: the sheet click enters the stance, deflect 0 → 1, marker "Stance: Stonestance" on the token, chat line; `api.endStance` clears it, deflect back to 0. |
| 7 | answered | The token ruler does not show the halved speed: neither the system nor Advanced Encounters customizes Foundry's ruler, which only measures distance. The sheet shows it (Move 15 ft). |
| 8 | pass | Stunned "until the end of its next turn" applied during Kal's turn survives that turn and ends at the end of Kal's next turn ("its duration ended"). |
| 9 | pass | Restrained on the Brute from the HUD during Shallan's slow turn: the dialog asks "Lasts"; "until the start of the slow PC phase next round" survives the Brute's turn, the new round and Kal's fast turn, ends as Shallan's slow turn starts. |
| 10 | pass | Surprised applied at round 1 before any turn ends after the Brute's first turn. |
| 11 | skipped | Needs a second GM login; none available. |
| 12 | pass (v0.3.1) | Ending the encounter: Empowered (end of scene) ends, the stance ends (deflect back), Recover recharges 0 → 1; a chat line for each. |
| 13 | pass | A long rest takes Exhausted 2 → 1 (see fix 6 for the overlap with Automated Actions). |
| 14 | pass | "End scene (EP Cosmere Automations)" is in the token controls (flag icon) and asks for confirmation first. |
| 15 | pass (card fixed) | Restrained: the Athletics dialog opens with the d20 on disadvantage; fast-forwarded tests too (`2d20kl`). The card's reason line was missing (fix 4); on v0.3.1 it shows. |
| 16 | **fail → fixed** | Sword attack on a Prone target opened without advantage (fix 5). On v0.3.1: the dialog opens with advantage, the card shows "Advantage: target Prone."; the bow gets none. |
| 17 | pass (v0.3.1) | The Brute uses Dodge (system asks to spend 1 focus) → Dodging; Kal's attack opens with disadvantage, card "Disadvantage: target Dodging.", Dodging is gone afterwards. |
| 18 | skipped | Needs a player login that owns `zz Shallan`; none available. The relay is covered by the Node tests only. |
| 19 | pass (v0.3.1) | Kal uses Brace → Bracing; the Brute's Strike: Mace on Kal opens with disadvantage; moving Kal's token ends Bracing ("it moved"). |
| 20 | pass (v0.3.1) | Gain Advantage with the Brute targeted posts the card; "The test succeeded" creates "Advantage gained: zz Brute" and disables the button; Kal's next test against the Brute rolls `2d20kh`, the effect is used up, the test after is normal. |
| 21 | pass | In Flamestance, Intimidation rolls with advantage ("Advantage: Flamestance."); Deception does not. |

**Fixes** (branch `ccr-fa029c81-c7h62m`, released as v0.3.1, commit 8374be1)

1. *Stances from the sheet* (9c94ebd). The handbook's stance talents grant no separate action; the sheet lists the
   talent itself as usable, and the system's `item.use()` returns null for anything that is not an action, so no
   hook fired. `Item.use` is wrapped (on `setup`): a talent with a modality enters its mode, following the stance
   setting; everything else goes to the system unchanged. (The sheet also posts the talent's own card; harmless.)
2. *Ending a stance* (9c94ebd). `actor.unsetFlag('cosmere-rpg', 'mode.stance')` always throws: the system's
   `preUpdateActor` reads `{mode: {'-=stance': null}}` as a modality named "-=stance" and writes an `undefined`
   deletion key, which Foundry rejects. (The system's own `clearMode` has the same problem.) `endStance` now calls
   `setMode('stance', null)` (or End Stance's id), which also disables every stance effect.
3. *Effects with a status of their own* (9c94ebd). The system's `ActiveEffect._preCreate` reads `this.id` for any
   effect with exactly one status; it is null unless the id is chosen and `keepId` is set. The stance marker and
   Dodging / Bracing / Advantage gained now get a random 16-character id (`createOwnEffects`).
4. *The card's reason line* (7497efb). The system's `ChatMessage.renderHTML` runs Foundry's render (which fires
   `renderChatMessageHTML`) and then replaces `.message-content` with its own card. The note now goes just before
   `.message-content` as a sibling, which survives.
5. *Melee or ranged* (3061ca2). The attack hooks get the system's "Strike: X" action, not the weapon: for a
   character it is an item embedded in the weapon with no attack data (the type is on the parent weapon); for an
   adversary it is a plain action whose description says "Reach 5 ft." or "Range 80/120 ft.". `attackTypeOf`
   reads the item, the parent weapon, then the description (neither or both words: unknown, melee/ranged rules
   skipped).
6. *Long rest and Automated Actions* (73eb616). With its "decrementExhaustion" on, both modules took the stack: at
   two stacks both wrote 1 (same stale value), at one stack both deleted the effect and ours failed. Ours now
   skips when that setting is on (under its master switch).

The fake Foundry in `test/` now reproduces the system behaviors behind fixes 1–3 (non-actions' `use()` returns
null, `unsetFlag` on a mode throws, single-status effects need a kept id); tests cover all six (114 pass).

**Open questions answered**

- *Token ruler / Advanced Encounters and Slowed:* no (check 7). Only the sheet shows the halved speed.
- *Automated Actions' "Let conditions modify rolls":* **on** in this world. It does not change the total, but after
  the roll it appends "- 2" to the formula for Exhausted 2 (seen: `1d20 + 0 - 2 = 6` on a d20 of 6; our −2 is
  already in the `+ 0`). So the total is right and the card's formula is misleading. **Decision for the GM:** turn
  that setting off while this module's Exhausted is at full.
- *"End scene" button:* yes (check 14).
- *Advantage/disadvantage reason line on the card:* not on v0.3.0; yes on v0.3.1 (fix 4).
- *Roll dialog opens with the expected button:* yes, the skill and attack dialogs show the d20 already on
  advantage or disadvantage (the system shows the mode on the die, not in the formula text).

**Other things seen**

- Advanced Encounters' ▶| button in the tracker advances the **round** (it ended Kal's turn and skipped the rest of
  round 1); turns are started with "Activate Combatant" and ended with `combat.nextTurn()`. Durations followed
  both correctly.
- A condition turned on by hand during combat opens the "Lasts" dialog (setting "ask during combat"); removing the
  condition while the dialog is open correctly skips its start line and links.
- With the same user connected from two browser tabs, every handler that checks "the user who made the change"
  runs in both, so chat lines doubled and linked conditions raced (errors "does not exist"). Not seen with one
  connection. Worth knowing for a GM who opens the game twice; not fixed.
- Weapons need to be equipped before their "Strike: X" actions appear on the sheet.

**Still open:** checks 11 (two GMs: one chat line per event) and 18 (player attack using up an NPC's Dodging
through the GM relay) need a second login.

## After the live pass (0.3.2)

The four rules the GM still had to remember after the pass are now automated (commit c7c439e, release v0.3.2).
Each follows its condition's setting (full / remind / off).

- **Afflicted's damage.** At the end of each of the afflicted actor's turns (the duration layer's turn-end event,
  on the active GM), each instance deals its damage through the system's `applyDamage`, one by one (deflect and
  immunities as the system does them; the system posts its damage card, with undo), with a chat line naming the
  source. This runs before effects lasting "until the end of its turn" end. Remind: a reminder with the amount.
- **Surprised: no fast turn.** On the active GM, whenever a Surprised actor's combatant is on a fast turn (when
  Surprised starts, when a combatant is added, when anyone switches it), it goes back to slow with a chat line. A
  boss's extra fast turn is a virtual copy the system makes (not a combatant), so a Surprised boss gets a reminder
  to skip it. Remind: a reminder instead of the switch.
- **Exhausted on another attribute.** The system builds the modifier from rank + attribute only (dropping every
  skill bonus) when `rollSkill` gets an `attribute` or another attribute is picked in the roll dialog. The Exhausted
  penalty is then added back as its own term, once per roll (the pre-roll hook for the option; the dialog wrapper
  compares the modifier term before and after).
- **Senseblind, Hidden, Invisible** (the system's statuses `blind`, `hidden`, `invisible`, which it marks as
  non-conditions). The handbook's targeting rule (ch. 10): a character who can't sense its target gains a
  disadvantage on attacks and other tests that affect the target's body, and those attacks can't graze (ch. 3: with
  your primary sense obscured you still sense things within your senses range). So:
  - Hidden / Invisible on the target: attacks against it gain a disadvantage. They are relative (someone may have
    spotted the hidden character), so the dialog's pre-selection is the place to drop it.
  - Senseblind on the attacker: a disadvantage only when the target's token is farther than the attacker's senses
    range (`system.senses.range`; never for senses with `obscuredAffected: false`). New rule option `beyondSenses`.
  - "Can't graze" is in the summaries, not enforced. Other tests that affect the body are left to the GM.
  - They have settings now (remind by default).

**Live check of 0.3.2 (2026-11-26, same world, throwaway `zz` scene and actors, deleted afterwards):**
Afflicted [3 Energy] took Kal 12 → 9 at the end of his turn, not at its start, with our line and the system's
damage card. Surprised moved Kal's fast combatant to slow, and the system's own speed toggle back to fast was
reverted at once. Exhausted 2 on an Athletics test with Intellect: `1d20 + 2 - 2` both fast-forwarded and chosen in
the dialog (total d20 + 0). A sword attack opened with disadvantage on a Hidden or Invisible target; a Senseblind
attacker (senses range 10 ft) had none at 5 ft and a disadvantage at 20 ft. Afterwards every mode setting of this
module was set to full in Stonewalkers, and Cosmere Automated Actions' "Let conditions modify rolls" turned off (its
"decrementExhaustion" stays on; ours defers to it).

## Held conditions (0.3.3)

Found while fitting the module to the campaign: a long rest took one Exhausted stack from everyone, including one
that an injury causes. The rules say an injury's effect lasts as long as the injury, and an effect's own duration
beats the condition's default ("−1 per long rest" is for Exhausted from hunger, thirst and the like). PF2e handles
the same thing with granted conditions: off-guard from prone can't be removed while prone stays. So:

- **A held condition can't be removed by hand.** If any of a condition's sources other than "manual" still exists
  (a parent condition, an item), deleting it from the token, sheet or API is refused with a warning naming the
  source. If it also had a manual source, that one is dropped instead (with its free stacks). The engine's own
  changes pass (links ending, durations, long rest), and so does `api.remove(..., { force: true })`.
- **Stacks belong to sources.** On Exhausted, a source records how many stacks it holds (`stacks`, default 1).
  The rest are free. A long rest takes a free stack only (a chat line says when it stays: "from Vicious Injury");
  stacks can't be taken below what the sources hold by hand; a source going takes its stacks with it.
- **`api.tie(actor, id, source, { stacks })`** ties a condition already on the actor to a source without adding to
  it (for conditions set before the module knew about the injury).
- Automated Actions' own long-rest reduction, if left on, is refused for held stacks by the same guard (with the
  warning), so it can't take an injury's stack either. Turning it off leaves the long rest to this module.
- **The code names no condition for any of this (0.3.4).** Holding comes from sources (the table's `links`, or an
  item given as `source`/`tie`); stacks from the table's `stackable`; the long-rest step from the table's
  `longRest`. An injury can't be a table link, since it is an item and the player picks its effect, so it is tied
  when applied.

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
