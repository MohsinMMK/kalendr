# Availability 2.0 (feature 37) — 19 November 2026

Built on `claude/w0-sched-36-37-cb1c11`, after feature 36. Migration `drizzle/0031_availability_schedules.sql`.

Where it ran: PostgreSQL **17.11** (Homebrew) on a throwaway cluster on `127.0.0.1:5545`, roles without `BYPASSRLS` for the app and worker, migrated from scratch. The 0027 backfill was also run on a database that already held the seeded team (36 rules became 6 default schedules, nothing lost). **Not run:** `scripts/verify-postgres18.sh` (Docker was not running), so nothing is verified on PostgreSQL 18.

## What was built

- **Engine** (`src/server/slot-engine/`): `working-hours.ts` is the chain of steps for one person and date (weekly pattern, date override, public holiday, out of office, blocked time, restriction schedule; travel picks the timezone a date is read in). `holidays.ts` wraps `date-holidays` 3.39.2 (ISC code, CC BY-SA 4.0 data, credited on the holidays panel). `explain.ts` replays the same steps and filters for "Why no slot?". `load.ts` reads schedules, overrides, travel, time off, holiday settings and the service's schedule and restriction.
- **Schedules**: several named schedules per person, one default; a service can use a schedule by name ("Home visits") or be narrowed by a restriction schedule.
- **Screens**: schedule picker, several ranges a day with "+", "×" and "Copy times to…", date overrides on a calendar, holidays (country, region, a switch each, custom closed days), out of office (reason, public note, cover person), travel (with the converted hours), and the "Why no slot?" sheet from the schedule page and the person's settings.
- **Routes**: `/api/staff/availability/{schedules,travel,time-off,explain}`, `/api/staff/holidays`, with version checks and an audit row each (no free text in metadata).
- **Booking page**: the out-of-office note is shown on the time step, and while a person with a cover teammate is away their cover's times are offered under their link.
- New permission `schedule.read` (receptionist, practitioner, owner and admin by default).

## Done when

| Criterion | How it was checked | Result |
| --- | --- | --- |
| 9–1 and 3–7 on Monday offers nothing between 1 and 3 | `working-hours.test.ts` (engine) and `e2e/availability.spec.ts` (saved through the schedule route, read from the public availability API) | Pass |
| Marking 25 December unavailable removes that day only | `working-hours.test.ts`; the browser spec does the same for a date three weeks ahead and checks the next day is still open | Pass |
| A turned-off holiday keeps the business open | `holidays.test.ts` and `explain.integration.test.ts` (Trinidad and Tobago lists Deepavali on 8 November 2026; turned off, the day is no longer a holiday) | Pass. **India:** the library's Indian data has only the six national holidays, no Diwali, so Diwali there is added with "Add a closed day" |
| A week of travel to Dubai shifts the slots by the right offset | `working-hours.test.ts` (Kolkata home, Dubai trip: 09:00 is 03:30Z before and 05:00Z from the first day away) and `explain.integration.test.ts` (against the database) | Pass |
| "Why no slot?" names the reason for each case | `explain.integration.test.ts`: outside working hours, holiday (named), out of office (with the note), already booked, buffer after the 11:00 visit, buffer before a visit, too soon, beyond the window | Pass for seven of the eight reasons in the spec. Daily limit (feature 38) and busy in Google Calendar (feature 16) add theirs when those land; the sheet already has labels for both |

Also tested: the overlap constraint, the version conflict between two managers, the cover person's slots while someone is away, a service's own schedule found by name, a restriction schedule, business B not seeing business A's schedules, and the old doctor-hours save still working (it now writes the default schedule).

## Known limits

- `date-holidays` throws on this Node version for 15 countries with Chinese-calendar holidays (BN CC CN CX HK ID KR MU MY PH SG SR TW VN). The holidays panel says so and the owner can add closed days by hand; nothing else breaks.
- Both the older simple weekly editor and the new schedule editor are shown on the Hours settings page; the old one writes the default schedule. Folding them into one is a follow-up.
- Out of office is whole days in the person's schedule timezone. Feature 20 reuses the same table for routing and bulk reassignment.
- The "Why no slot?" check only reads settings; it needs `schedule.read`.
