# Build waves

Written 19 November 2026. This is how the remaining plan (every feature except 1, 35 and the dropped 33) gets built as fast as possible.

## Who does what

| Role | Model | Where |
| --- | --- | --- |
| Builders | Sonnet 5.5, high effort (medium for screen-only work) | One session per lane, each in its own git worktree cut from `kalendr-generalization` |
| Integrator | The coordinating Opus session | Merges each branch into `kalendr-generalization` one at a time, renumbers migrations, runs `pnpm check` after each merge |
| Reviewers | Two Opus 5.5 sessions, medium effort, after the last wave | One reviews engine, security and money; the other reviews screens and integrations. They read the diffs, not the builders' summaries |
| Final check | The coordinating session, then the owner by hand | Browser tests of every Done-when |

At most five sessions run at once. Each builder may use 2–3 subagents for its own parallel pieces.

## Lanes

A lane owns a set of files, so two sessions never edit the same area in one wave.

| Lane | Owns |
| --- | --- |
| A Messaging | `src/server/messages*`, channels, workflows, waitlist, campaigns |
| B Identity | auth, sign-in, permissions, privacy, platform admin, billing, enterprise |
| C Scheduling | `src/server/slot-engine/`, the booking commit in `appointment-repository.ts`, `service-editor.tsx`, booking page, bookings list |
| D Money and data | payments, invoices, packages, reports, CRM |
| E Platform | live updates, calendar sync, video, public API, embeds, apps, AI |

## Waves

A wave starts once the previous wave's branches are merged and the trunk is green. The exception is wave 0, which runs alongside the integration.

| Wave | A Messaging | B Identity | C Scheduling | D Money and data | E Platform |
| --- | --- | --- | --- | --- | --- |
| 0 | Integrate the finished branches for 2, 9, 10, 22 and 31 (one session) | | 36 → 37 | | |
| 1 | 3 → 4 | 6 → 7 | 38 → 39 → 40 | 5 → 19 | 32 → 16 |
| 2 | 8 → 21 → 17 | 15 → 14 | 41 → 42 → 43 | 23 | 34 → 12 |
| 3 | 20 → 18 | 13 → 11 | 44 → 45 → 48 → 50 | 24 → 25 | 52 → 56 → 54 |
| 4 | 26 → 51 | 53 | 27 → 28 | 30 | 55 → 57 |
| 5 | 46 | 29 | | | |
| Review | | | | | |

Later waves have their own docs: [customization-wave.md](customization-wave.md) (22 Nov) and [calcom-parity-wave.md](calcom-parity-wave.md) (25 Nov, three lanes on `master`).

Each arrow means "in order, in the same session". Every feature's Needs line is met by an earlier wave or by an earlier step in the same session.

## Rules for every builder session

1. Read `AGENTS.md`, `docs/build-plan/STANDARDS.md` and your features' specs first. Read the relevant guide in `node_modules/next/dist/docs/` before writing Next-specific code.
2. **UI:**
   - Use the official coss compositions (`.claude/skills/coss`).
   - Prefer rich dropdowns over extra buttons.
   - Keep one row of buttons that never wraps; extras go in ⋯, which becomes a bottom sheet on mobile.
   - Pages fit the screen.
   - Use proven libraries where they help, styled to the coss design language.
3. **Backend:**
   - Validate with zod at every boundary.
   - Use `withTenant` and row-level security.
   - No outside calls inside a request; use the outbox and the worker.
   - Tokens are 256-bit and stored hashed.
   - Never log phone, email, name, token or message body.
   - Money rows are never edited.
   - Free text stays out of audit metadata.
   - Use pnpm only.
4. **Outside services:** build against local capture or test mode when there is no account yet. List everything that needs the owner's real account under "Needs your credentials" in the final report. Never call that part done.
5. **Migrations:** generate with `pnpm db:generate` on your branch. Number clashes with other lanes are fixed by the integrator at merge time.
6. **Shared files** (`src/db/schema.ts`, `settings-workspace.tsx`, `appointment-task.tsx`, `permissions.ts`): add, don't restructure. Keep edits to new sections and one-line hooks.
7. **Tests:** each feature's Done-when becomes tests (vitest, plus Playwright where it is a screen flow). Before finishing, merge the latest `kalendr-generalization` into your branch and get `pnpm check` green.
8. **Finishing:**
   - Commit each feature separately on your branch, with the attribution line.
   - Never push and never merge into `kalendr-generalization`.
   - Report the branch name, each feature's Done-when result, and anything not finished.
9. **Credentials:** never print values from `.env*`, `.local-db/` or credential files.
