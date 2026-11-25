# Booking page 2.0 (feature 39) — 19 November 2026

Built on `claude/w1c-sched-38-40-eb5e5f`. Migration `drizzle/0036_booking_page.sql` (hand-written). Same database and caveats as the booking limits note: PostgreSQL 17 on a throwaway cluster, not PostgreSQL 18.

## What was built

- **Layouts**: month, week and column views (`src/features/booking/month-view.tsx`, `week-view.tsx`, `column-view.tsx`) behind one picker. Each service allows some layouts and picks the first one shown (`services.layouts_enabled`, `default_layout`); the choice is kept in the address (`?layout=week`) with nuqs so a shared link opens the same view. On a phone, week and column fall back to month.
- **Time zones**: the API still returns UTC. The picker reads the visitor's zone, offers a searchable zone select, and says "Times shown in Dubai time (1 h 30 m behind the clinic)" when it differs. A service can lock the page to the branch's own time (`services.lock_timezone`).
- **Clock and week start**: 12 or 24 hours from the visitor's locale with a switch; the business sets a default (`tenants.default_clock`); week start per service (`services.week_start`) or the business's (`tenants.week_start`).
- **Slot holds** (`src/server/slot-holds.ts`, `POST/DELETE /api/public/holds`): picking a time takes a five-minute hold in `slot_holds` (256-bit token, only its hash stored). It takes the same person-row lock a booking takes and runs the same engine check, so a hold and a booking cannot both win. The engine reads live holds as busy time for everyone else and ignores one past `expires_at`, so a missed clean-up never keeps a time closed; the worker's `hold-expiry` job also deletes expired rows. One live hold per browser: picking another time sends the old token as `replaceToken`. The booking commit turns the customer's own hold into the booking and deletes it. The table has a `purpose` column so feature 23's payment hold can reuse it.
- **Team and person pages**: `/b/[business]/team` lists every person who takes bookings with what they offer and their next free time (searched through the engine, cached for a minute); `/b/[business]/[person]` moves to the person's page. The profile page already existed.
- **Staff screens**: a "Booking page" tab in the service editor and "Booking page times" (clock, week start) under Settings > Business.

## Done when

| Criterion | How it was checked | Result |
| --- | --- | --- |
| A visitor in Dubai sees times in Dubai time and the clinic sees its own | picker tests with `Asia/Dubai` and `Asia/Kolkata`; `booking-page.test.ts` for the offset line (1 h 30 m) | Pass |
| With the lock on, everyone sees clinic time | picker tests (locked service) | Pass |
| Month and week views switch and the link is shareable | picker tests (`layout` in the address) | Pass |
| A second customer cannot see or take a slot someone is filling in; after 5 minutes it returns | `slot-holds.integration.test.ts` (hidden from the listing, refused as a hold and as a booking, expires without the job, replace, own hold becomes the booking) | Pass |
| The team page lists every active person with their next free time | `src/app/b/[clinicSlug]/team/page.tsx` renders `loadNextOpenings` | Built; checked by the browser journey below |
| Another business cannot see these holds | `slot-holds.integration.test.ts` as another tenant | Pass |

## Known limits

- The hold's five minutes are not extended while the customer types; the page counts down and offers to pick again.
- `loadNextOpenings` searches a week ahead through one service per person; a person who only does a much longer service may show a later time than another service would.
- A day that is full in the business's zone but straddles two days in the visitor's zone is only marked full when the visitor's day is fully covered.
