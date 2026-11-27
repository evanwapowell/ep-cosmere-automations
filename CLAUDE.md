# EP Cosmere Automations: working notes for Claude

A Foundry VTT module for the Cosmere RPG system. Read `README.md` for what it does and `DESIGN.md` for why.

## Branches and releases

`main` is the only source of truth. Every release is cut from `main`, and `main` always holds the code of the
latest release. (Releases v0.3.0 to v0.3.6 were tagged on a session branch that was never merged, so `main` showed a
design-only repo while a working module was installed in a live world. Don't repeat that.)

- **Start from `main`.** Before any work, fetch `origin/main` and make sure the working branch contains it. If the
  branch is behind, merge `origin/main` into it first.
- **Finish on `main`.** When a piece of work is done and `node --test` passes, merge the working branch into `main`
  and push `main`. This file is the owner's standing permission to do that for this repository; no need to ask each
  time. Use a normal merge or a fast-forward. Never force-push `main` and never rewrite its history.
- **If the work isn't ready** (tests fail, or it is half done), push the working branch only and say plainly in the
  final message that it is not merged, and why.
- **Never release from another branch.** Run `tools/release.sh <version>` only on `main`, with `main` up to date with
  `origin/main`. In Actions → Release → Run workflow, pick `main`. If a tag is ever needed for code that is not on
  `main`, stop and ask.
- **After a release**, check that the tag's commit is on `main` (`git branch -r --contains v<version>` lists
  `origin/main`).
- **Before answering "what is built?"**, look at all branches and tags (`git ls-remote origin`), not only the
  checked-out branch.

## Working on the code

- `node --test` runs everything; it needs no install. Run it before every commit that touches `scripts/`, `data/` or
  `test/`.
- Pure logic lives in `scripts/logic/` and `data/` with no Foundry globals; Foundry glue lives in `scripts/*.js` and
  is tested against `test/fake-foundry.js`. Keep that split: new rules get a pure function and a test first.
- Every hook handler goes through `safe()` (`scripts/util.js`) so a system change disables one feature instead of
  breaking rolls.
- The module depends on internals of `cosmere-rpg` 3.1.x (hook names, the `cond<status>` effect ids, the stance
  flag). Re-check the system source (`the-metalworks/cosmere-rpg`, public) before relying on anything new.
- Unit tests don't prove behaviour in Foundry. Anything that changes what happens at the table needs a live pass on a
  throwaway `zz` scene (`docs/LIVE-PASS.md`) before it is called working; say so when a change has not had one.
- Public repo: no campaign or adventure content, no rules text copied from the books (summaries in our own words),
  no credentials.
