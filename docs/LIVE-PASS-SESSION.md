# Live pass: prompt for a Claude Code session on your computer

How to use: open Claude Code on the computer whose browser is signed in to Foundry (desktop app → Code, or
`claude` in a terminal) **in your local clone of this repository**, then paste everything below the line as the
first message. The session needs browser control (Claude in Chrome or the desktop app's browser), as last time.

---

Do the live pass for the EP Cosmere Automations Foundry module, using my browser. I'm signed in to my Foundry
server at https://ewap.club; the Setup screen is open and logged in as admin.

## Repo and branch

- Repository: evanwapowell/ep-cosmere-automations. Run `git fetch origin` and check out branch
  `ccr-fa029c81-c7h62m` (it is ahead of main). Commit fixes there and push to that branch only. Don't open a pull
  request, don't push to main.
- Read first: `docs/LIVE-PASS.md` (the runbook: install, settings, setup, 21 numbered checks, cleanup, report), then
  "System facts" and the "Phase 1/2/3 as built" sections of `DESIGN.md`.
- Tests: `node --test` from the repo root (Node's built-in runner, no dependencies). Keep them passing; add a test
  when a fix changes logic.

## Steps

1. **Install** from the Setup screen: Add-on Modules → Install Module → Manifest URL
   `https://github.com/evanwapowell/ep-cosmere-automations/releases/latest/download/module.json`
   (release v0.3.0 or later). If it is already installed, use Update instead.
2. **Launch the "Stonewalkers" world.** Ask me first if a game might be in progress, and suggest a world backup
   before testing. Enable "EP Cosmere Automations" in Manage Modules, save, reload.
3. **Follow `docs/LIVE-PASS.md` sections 1–5.** Ground rules: only on a scene named `zz live pass`; only `zz` test
   actors you create; never change the campaign's own actors, scenes, journals or other modules' settings; GM-only
   rolls where possible. Check 18 needs a second login as a player: if there's no player account you can use, skip
   it and say so. Don't create users with blank passwords without asking me.
4. **When a check fails:** read the browser console (the module's lines start with `ep-cosmere-automations |`),
   find the cause in the code, fix it on the branch, run `node --test`, commit and push. To get the fix into
   Foundry, release it: `tools/release.sh 0.3.1` (then 0.3.2, …) tags and pushes, and the "Release" GitHub Actions
   workflow publishes it within a minute or two (check the repo's Actions tab). Then Setup → Add-on Modules →
   Update, relaunch the world, and re-run the check. Group several small fixes into one release when you can.
   While iterating on one problem you may also test a change by running code in the GM's browser console first.
5. **Answer these open questions while there:** does the token ruler / Cosmere Advanced Encounters show the halved
   speed when Slowed? Is Cosmere Automated Actions' "Let conditions modify rolls" on (then Exhausted applies
   twice)? Does the "End scene" button appear in the token controls? Does the chat card show the
   advantage/disadvantage reason line? Does the roll dialog open with the expected button selected?
6. **Clean up:** delete the `zz` scene, the `zz` actors and the test chat messages; set this module's settings back
   to remind-only (its safe default) unless I say otherwise.
7. **Report:** add a "Live pass results (date)" section to `DESIGN.md` with each check's pass/fail and what was
   seen, the fixes (commit ids and release versions), and the answers to the open questions. Commit and push. Then
   tell me in chat what passed, what failed, what you fixed and what still needs a decision.

## Context

Phases 1–3 (conditions with mechanics and links, durations with Cosmere's turn rules, and the
advantage/disadvantage roll layer) were written in a cloud session and unit-tested against a fake Foundry only.
This is their first run in a real world: Foundry v13, cosmere-rpg 3.1.2, Stormlight Handbook content, Cosmere
Advanced Encounters. The repo is public: no campaign content, credentials or book text in commits.
