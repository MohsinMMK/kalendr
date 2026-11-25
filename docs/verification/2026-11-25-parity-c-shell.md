# Cal.com parity wave, lane C: staff shell, time off and owner summary (25 Nov 2026)

Branch `claude/parity-c-shell-0a9cf8`. Migration `0083_owner_summary` (journal idx 82, when 1797900000000): `memberships.summary_frequency` (off, weekly, monthly; empty follows the role), `memberships.summary_sent_for`, and the definer function `kalendr_owner_summary_tenants()` (ids only, revoked from the web role in `scripts/migrate.mjs` and `scripts/e2e-database.mjs`).

## What was built
- **Sidebar booking link:** `booking-link-pin.tsx`, one line in `clinic-frame.tsx`. Shows `/book/<slug>` with Copy and Open for roles that hold `appointments.book`; hidden otherwise, in preview, and when the sidebar is folded.
- **Copilot starter prompts:** four, worded through `useTerms()` (`assistant/starter-prompts.ts`); clicking sends it; they vanish once the chat has messages.
- **Routing form templates:** three drafts (which service, new or returning, pick a location) created through the existing create route on an empty page.
- **Time off:** `TimeOffScreen` with My time off (Team time off for a login with no bookable profile) and Holidays; each entry shows what a booker sees (the note, and whose times appear). Same `time_off` and holidays APIs.
- **Owner summary:** hourly job `owner-summary` (`src/worker/owner-summary-jobs.ts`), outbox event `staff.summary`, handler `ownerSummaryHandler`, email `src/emails/owner-summary.tsx`. Owners choose Off, Every week or Every month in Notifications.

## Tested
- Vitest: `owner-summary.test.ts` (periods, defaults, wording), `owner-summary-email.test.tsx` (renders numbers), `time-off-panel.test.ts`, copilot and routing workspace tests.
- Database (`src/server/owner-summary.integration.test.ts`, scratch PostgreSQL 17, run twice): real counts (bookings 1, cancellations 1, no-shows 1, revenue), nothing private in the row, one row per period, opt-out stops it, monthly only on the 1st to 3rd, only owners may choose, handler email to the owner's own address.
- Playwright `e2e/parity-c-shell.spec.ts` plus `staff-notifications.spec.ts` on desktop: 8 of 8 pass, with accessibility scans on the sidebar and routing page. Screenshots at 375 and 1440 wide are in `2026-11-25-parity-c-shell/`.

## Not covered
- The phone Playwright project was not run; 375px is checked by screenshot only.
- The summary email was rendered and delivered to a fake sink, not through the capture server end to end.
- PostgreSQL 18 not run.
