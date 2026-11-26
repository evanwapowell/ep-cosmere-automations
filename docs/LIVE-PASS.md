# Live pass: phases 1–3 in a real world

A runbook for a Claude session that controls the GM's browser (or for the GM by hand). Goal: confirm in a live
Foundry what the Node tests could only fake, fix what breaks on branch `ccr-fa029c81-c7h62m`, and record the
results under "Live pass results" in DESIGN.md.

Ground rules: test only on a scene whose name starts with `zz`; use test actors made for the purpose and delete
them, the scene and the test chat messages afterwards; never touch the campaign's own actors, scenes or journals;
take a world backup before step 1 if the world matters.

## 0. Install (Setup screen, admin)

Install Module → Manifest URL:

    https://raw.githubusercontent.com/evanwapowell/ep-cosmere-automations/ccr-fa029c81-c7h62m/dev-manifest.json

It downloads the branch as a zip. To pick up fixes later: Setup → Update the module (or uninstall and reinstall).
Then launch the world, Manage Modules → enable "EP Cosmere Automations", reload.

## 1. Load check (F12 console as GM)

    game.modules.get('ep-cosmere-automations').api    // an object with apply, remove, list, …

Watch the console for lines starting `ep-cosmere-automations |` and any errors during load.

## 2. Settings for the pass

Configure Settings → EP Cosmere Automations: set to **Full** the conditions Prone, Slowed, Unconscious, Exhausted,
Enhanced, Afflicted, Restrained, Stunned, Surprised, Empowered; and Durations, Stances, Advantage and disadvantage,
Effects from Dodge/Brace/Gain Advantage, Recharge per-scene uses. Chat lines: Everyone.
(If Cosmere Automated Actions' "Let conditions modify rolls" is on, note it: Exhausted would apply twice.)

## 3. Setup

Duplicate any scene, name it `zz live pass`, view it. Create two test characters (`zz Kal`, `zz Shallan`) with
Speed 3 or 4, and drag in one adversary token (`zz Brute`). Give `zz Kal` a sword-type melee weapon, a ranged
weapon, Stonestance + Flamestance talents and the Recover / Dodge / Brace / Gain Advantage actions if not present.

## 4. Checks

For each: what to do → what should happen. Record pass / fail / note.

**Phase 1**
1. Token HUD: Prone on `zz Kal` → Slowed appears; walking speed on the sheet halves; chat "is now Prone", "is now
   Slowed (from Prone)". Remove Prone → both gone.
2. Unconscious → Prone and Slowed appear; movement 0. Remove Unconscious → all three gone.
3. Exhausted, then raise to 2 stacks → every skill modifier on the sheet is 2 lower; a skill roll's total agrees.
4. `api.apply(kal, 'enhanced', {value: {attribute: 'spd', amount: 2}})` → name "Enhanced [Speed +2]", skills of
   Speed and movement rise, Physical defense does not.
5. Afflicted from the HUD → dialog asks damage type and amount; name shows the value.
6. Stances set to Full: use the Stonestance action from the sheet → deflect +1 on the sheet, marker "Stance:
   Stonestance" on the token. `api.endStance(kal)` → marker gone, deflect back.
7. Does the token ruler / Advanced Encounters show the halved speed when Slowed? (open question from phase 0)

**Phase 2** (start a combat with the three tokens; Advanced Encounters on)
8. Start `zz Kal`'s turn; `api.apply(kal, 'stunned', {duration: 'endOfNextTurn'})`. End the turn → still Stunned.
   Next round, start and end Kal's turn → Stunned ends, chat "its duration ended".
9. During `zz Shallan`'s (slow PC) turn, toggle Restrained on the Brute from the HUD → the dialog asks "Lasts";
   pick "Until the start of this phase next round". Next round: still there during fast turns; ends when the first
   slow PC turn starts.
10. `api.apply(brute, 'surprised')` at round 1 before any turn → ends after the Brute's first turn.
11. Two GMs logged in? Check only one chat line per event.
12. End Combat → effects lasting until the end of the scene end, the stance ends, Recover's use recharges.
13. A long rest on `zz Kal` with Exhausted 2 → Exhausted 1.
14. Token controls: the "End scene" button exists (flag icon) and asks before doing anything.

**Phase 3** (target with the Targeting tool; one target at a time)
15. Restrained on `zz Kal`, roll Athletics from the sheet → the dialog opens with **Disadvantage selected**; the
    card shows "Disadvantage: Restrained." Shift-click (fast-forward) also rolls with disadvantage.
16. Prone on the Brute, Kal targets it, attack with the melee weapon → attack dialog opens with Advantage
    selected; the card shows "Advantage: target Prone." With the ranged weapon → no advantage.
17. The Brute uses Dodge (from its sheet), then Kal attacks it → disadvantage; Dodging is removed afterwards.
18. Relay: log in a second browser as a player who owns `zz Shallan`; the Brute Dodges; the player attacks it →
    disadvantage, and the GM's client removes Dodging.
19. Kal uses Brace → Bracing on the token; the Brute's attack on Kal has disadvantage; move Kal's token → Bracing ends.
20. Kal targets the Brute, uses Gain Advantage → a card with "The test succeeded"; click → "Advantage gained:
    zz Brute" on Kal; Kal's next test against the Brute has advantage, then the effect is gone.
21. Kal in Flamestance → Intimidation test with advantage.

## 5. Clean up

Delete the `zz` scene, the `zz` actors and the test chat messages. Put the module settings back to what the
GM wants (all remind-only is the safe default), or disable the module.

## 6. Report

Add "Live pass results (date)" to DESIGN.md: each check pass/fail with a line of what was seen, the fixes made
(with commit), and the answers to the open questions (token ruler speed, Automated Actions overlap).
