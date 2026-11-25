# Staff workspace upgrade (feature 31) — 12 November 2026

Built a react-query data layer, a schedule with drag to move, drag to resize and undo, four
views kept in the address bar, a command palette on a server search, keyboard shortcuts, bulk
actions on the list, a phone layout with a bottom bar, a light/dark/system theme, loading
skeletons that match the screen, a printable day sheet, and a windowed list. Everything below
ran on this machine against local PostgreSQL 18.6 containers and a production build
(`next build --webpack`, `next start`). No message was sent to anyone.

Two things in the plan depend on features that do not exist yet:

- **Live updates (feature 32).** The schedule refetches when the window gets focus and after every
  change. Query keys are laid out so an event can invalidate them later (`keysForLiveEvent` in
  `src/features/clinic/queries/keys.ts`).
- **Team routing (feature 20).** Dragging a visit onto another staff member's row uses the existing
  reschedule route (`PATCH /api/staff/appointments/:id`). That route accepts any staff member who
  offers the visit's service and refuses the rest, so cross-row drag is on, not disabled.

## Final results

- `pnpm check` (lint, typecheck, tests, build): exit 0. 559 tests passed, 22 skipped (the ones that need a database).
- `scripts/verify-postgres18.sh`: exit 0, 17 integration tests passed (one new, for resize and the notify flag).
- Browser journeys, desktop and phone, one run on a freshly seeded database: **26 passed, 4 skipped** (the four desktop-only journeys on the phone project), including every journey that existed before.
- `pnpm knip`: exit 0 (warnings only, as before).

## "Done when", one by one

| Criterion | What was done | Result |
| --- | --- | --- |
| A drag to a new time updates the server and can be undone | Journey `a dragged visit moves on the server…`: two visits booked through `POST /api/staff/appointments`; the first dragged two hours later, confirmed in the dialog, the database row read back; then **Undo** on the toast; the row read again | Start time changed in the database, then returned to the original. Version checked in `appointment-repository.integration.test.ts` |
| A drag onto a clash snaps back with a reason | Same journey: the first visit dragged onto the second | Toast "That time is taken" with the reason, card back where it was, database row unchanged |
| Drag the end to change length; drag to another staff member's row | Same journey: a third visit's end dragged by half an hour (database end +30 min, start unchanged); the first visit dragged down to Dr Kavya's row, then Undo | Both changed in the database and were put back |
| Ask before telling the customer, default set by the business | The drop opens a dialog with "Tell … about the new time", ticked from the business's **Tell customers when you move them** setting (a new switch under Settings → Features, on by default) | `notifyCustomer: false` is written to the outbox payload and the audit row when unticked; asserted in the integration test. The worker that will read it (feature 1) does not exist yet |
| The palette finds a real customer by part of a phone number | Journey `the palette finds a customer from part of a phone number`: `Ctrl+K`, the last five digits of a booked customer's number | The customer appears (server search, 250 ms debounce), the axe scan of the open palette passes, Enter/click opens the customer page |
| Reloading keeps the same view and date | Journey `the view and date stay in the address…`: view switched to List, page reloaded, Back pressed | `?view=list&date=…&location=…` survive a reload; Back returns to the previous view; an open appointment is in the address (`open=`) and a reload shows the same card |
| Every daily action works by keyboard | Same journey | `→` changes the day, `T` returns to today, `N` opens a new appointment, `?` shows the list, `/` focuses search; typing `nt/?` into the search box triggered none of them and a dialog open blocks them (14 unit tests in `hotkeys.test.tsx`) |
| Works one-handed on a 360px phone | Journey `the schedule fits a 360px phone…` at 360 × 740 on both projects | Bottom bar (Today, Schedule, Patients, Messages, More) each at least 44 px tall; the day is a vertical list; no sideways scroll; axe passes |
| Reads well in dark mode | Same journey, with the `kalendr-theme=dark` cookie | The page carries `dark`; axe contrast passes on the schedule (list, staff, week), Today, Patients, Messages and Doctors in dark. Two contrast findings were fixed to get there (see below) |
| Bulk actions on the list | Journey `several visits can be cancelled together with a reason`: two visits ticked, Cancel with a reason. Journey `several visits can be handed to another staff member…`: two visits ticked, one of them clashing with the new staff member's own visit | Both cancelled rows read back as `cancelled`. The hand-over moved the free visit, left the clashing one with Dr Arjun, still ticked, with its reason in the dialog and "Moved 1. 1 could not be moved" in the toast. Message is a list of numbers to copy (see Known limits) |
| Printable day sheet | `/print/day`, printed to A4 PDF through Chromium in the journey | Two pages for the two staff members (page count asserted); axe passes; rows do not split across pages |

## Smooth with a long day

`scripts/measure-schedule-frames.mjs` against the production build, headless Chromium, one
business with **300 visits on one day** (`scripts/seed-schedule-load.mjs --mode load --count 300`),
1366 × 900. Frame time is the gap between animation frames; 16.7 ms is 60 frames a second.

| View | Interaction | Median | 95th percentile | Frames over 33 ms | Long tasks |
| --- | --- | --- | --- | --- | --- |
| Staff timeline (112 of 300 drawn, the rest in "+N more") | scroll sideways | 16.7 ms | 33.3 ms | 3 of 165 | 0 |
| | drag a card | 16.7 ms | 16.7 ms | 0 of 85 | 0 |
| | type 8 letters in the search | 16.7 ms | 16.7 ms | 0 of 45 | 0 |
| Week (326 visits drawn) | scroll sideways | 16.7 ms | 16.8 ms | 1 of 141 | 0 |
| | drag a card | 16.7 ms | 16.7 ms | 0 of 85 | 0 |
| | type in the search | 16.7 ms | 16.8 ms | 0 of 45 | 0 |
| List (16 rows drawn of 300) | scroll the whole list | 16.7 ms | 16.8 ms | 0 of 198 | 0 |
| | type in the search | 16.7 ms | 16.7 ms | 0 of 45 | 0 |

Headless Chromium on a laptop is not a phone; the numbers say the screen does no work that
scales with the day, not that every device will hit 60.

## Tests added

- `src/features/clinic/queries/queries.test.tsx` and `bulk.test.ts`: keys, live-event mapping, optimistic move and resize, rollback of only the refused card, status change, debounced server search, one-at-a-time bulk with per-visit failures.
- `hotkeys.test.tsx`: every key, modifiers, held keys, text boxes, dialogs (including a closed dialog kept hidden in the page), the calendar's own arrow keys.
- `command-search.test.ts` (dates typed into the palette), `windowing.test.ts` (windowed rows), `staff-snapshot-provider.test.tsx` (now on the query cache), `schedule-workspace.test.tsx` (rewritten for the address-bar state).
- `appointment-repository.integration.test.ts`: resize changes the end and the reservation, refuses a clash, a too-short or too-long visit and a stale version, and records `notifyCustomer: false`.
- `e2e/staff-schedule.spec.ts`: seven journeys. Three run on desktop and phone (palette, 360 px and dark mode, day sheet including a PDF page count); four are desktop-only where a pointer or keyboard is the point (drag, keyboard and address bar, two bulk actions).

## Found and fixed during verification

- **The setup page broke.** `/setup` renders `StaffSnapshotProvider` outside the staff frame, so it had no query client ("No QueryClient set"). The existing `owner-setup` journey caught it; `src/app/setup/page.tsx` now provides one.
- **Shortcuts did nothing.** A closed dialog stays in the page, hidden, and the check for "a dialog is open" counted it. Only a dialog that is showing counts now.
- **Dialog footers fell out of the card.** A `<form>` between the dialog's parts broke its layout; the coss pattern (`className="contents"`) fixes it.
- **Dark theme contrast.** Muted text (`--muted-foreground`) was 4.2:1 on cards and bands; it is now neutral-400. Unselected tabs and segmented-control items used 72% of the muted colour (about 3:1 in the light theme as well); they use the full colour.

## Known limits

See the feature 31 section of `docs/PLATFORM_ROADMAP.md`. In short: no live updates yet, the
production worker does not read `notifyCustomer` yet, bulk "Message" copies numbers instead of
sending, preview mode still reviews a drag on the appointment page, and "match this device"
paints light for a moment on a full page load.

## Not tested

- A real phone or a real touch drag (the phone journeys use a 360 px viewport and a mouse).
- Drag on a touch screen: KLOQ has touch handles, but no journey drives them.
- Printing on paper; the layout was checked as a Chromium PDF only.
- Two people changing the same visit at once through the browser (the version check is covered by the integration test and by the toast text, not by two browsers).
