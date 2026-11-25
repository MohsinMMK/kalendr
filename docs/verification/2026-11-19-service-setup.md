# Service setup 2.0 (feature 36) — 19 November 2026

Built on `claude/w0-sched-36-37-cb1c11`. Migration `drizzle/0030_service_setup.sql`.

Where it ran: PostgreSQL **17.11** (Homebrew) on a throwaway cluster on `127.0.0.1:5545`, roles `kalendr_local_owner`, `kalendr_local_app` (no `BYPASSRLS`) and `kalendr_local_worker`, migrated from scratch with `scripts/migrate.mjs`-equivalent grants and seeded with `scripts/seed-local-db.mjs`. **Not run:** `scripts/verify-postgres18.sh` (Docker was not running on this machine), so nothing here is verified on PostgreSQL 18.

## What was built

- **Slot engine** (`src/server/slot-engine/`): `offerableSlots(input)` is a pure function. `load.ts` reads the data inside the transaction; `service-rules.ts` has the grid, buffers, notice and window; `working-hours.ts` is the per-day chain (feature 37 adds its steps there); `offerable-slots.ts` holds the filter list later features extend; `commit.ts` is what the booking commit calls after it has locked the person.
- `listAvailability`, patient reschedule, staff reschedule, public booking and staff booking all use it. The old SQL slot query and the three SQL checks in the commit are gone.
- **Service editor** (`service-editor.tsx`): a drawer with Basics, Lengths and prices, Timing, Where and Look; the tab list is an array so later features add a tab.
- **Routes:** `GET`/`PATCH` `/api/staff/services/[id]` (`expectedVersion`, `version_conflict`), `POST …/duplicate`, `/book/[business]/[service-slug]`.
- **Booking page:** length step (one card per length, with its price), a "how would you like to meet" step, banner and colour dot.

## Done when

| Criterion | How it was checked | Result |
| --- | --- | --- |
| A 15-minute after-buffer, 24-hour notice and 30-day window stop the public page offering slots that break them | `src/server/slot-engine/commit.integration.test.ts` and `e2e/service-setup.spec.ts` (editor sets the values, the availability API is asked for the next 20 hours, days 31–33, and a normal day) | Pass |
| A direct API booking that breaks one is refused with a clear error | Same integration test: booking 2 hours ahead, 40 days ahead and a length the service does not list | 409 `slot_unavailable`; the window message says "further ahead"; notice names the hours |
| A service with 30/45/60 minute lengths shows three prices and offers different slots for each | Integration test (30 vs 60 minute slot counts and lengths) and the browser spec (three prices on the length step) | Pass |
| A hidden service is absent from the business page but books from its link | `e2e/service-setup.spec.ts` and `services-admin.integration.test.ts` | Pass |
| Duplicating a service gives an editable copy in one click | Browser spec (⋯ menu → Duplicate → "(copy)" in the editor) and the integration test (lengths, ways of meeting, people and branches copied) | Pass |
| Two people taking the last slot: one wins | Integration test, two parallel `createAppointment` calls | One booking, one refusal |
| DST | `offerable-slots.test.ts`: Europe/London, 28–30 March 2026 | 09:00 local is 09:00Z on the 28th and 08:00Z after the clocks go forward; eight slots each day |
| Business-day window across a closed weekend | `offerable-slots.test.ts` | Thursday + 2 business days offers Thu, Fri and Mon only |

Browser spec ran on the desktop and the Pixel 7 project, with an accessibility scan of the editor drawer. The customer-books, customer-manages and double-booking journeys still pass, after one small fix to the country picker in the phone field (it had no accessible name).

## Behaviour to know

- A start must have its visit and both buffers inside a working range (the old rule, kept).
- The slot grid now comes from the service (`slot_interval_minutes`, empty = "same as the length") and `start_offset_minutes`; the per-rule interval column is no longer read.
- A visit keeps the length it was booked for when it is rescheduled.
- Hold reservations that have expired no longer block a slot.

## Found by the browser tests and fixed in the feature 37 commit

The first commit of this feature has two bugs the browser tests then found, both fixed in the next commit on this branch:

- The editor drawer opens inside the older "visit types" form, and its Save also submitted that form, which wrote empty prices over the new lengths. The editor now stops that submit, the older form's save no longer writes a price label or length that did not change, and a unit and an integration test pin both.
- The lengths and timing fields read the last render's values, so two quick edits could overwrite each other.

## Known limits

- `drizzle-kit generate` needs a terminal and there is no snapshot for 0025, so 0026 is hand-written like 0025.
- `react-hook-form` and `@hookform/resolvers` were not installed although the standards name them; they were added.
- "Video" is a placeholder until feature 19. "They call us" shows the business phone after booking.
- The staff booking form does not yet offer a length choice (the API accepts `durationMinutes`), and staff screens do not yet show how a visit is to be met or the customer's address; the data is stored (`location_kind`, sealed `location_detail`).
- A desk or walk-in booking never asks how to meet: with several ways it books in person at the branch.
