# Booking limits (feature 38) — 19 November 2026

Built on `claude/w1c-sched-38-40-eb5e5f`, after features 36 and 37. Migration `drizzle/0035_booking_limits.sql` (hand-written; `drizzle-kit generate` needs a terminal). Renumber on a clash.

Where it ran: PostgreSQL **17.x** (Homebrew) on a throwaway cluster on `127.0.0.1:5545`, roles without `BYPASSRLS` for the app, migrated from scratch. **Not run:** `scripts/verify-postgres18.sh` (Docker was not running), so nothing here is verified on PostgreSQL 18.

## What was built

- **Rules** (`src/server/slot-engine/limits.ts`, `limits-load.ts`): a limit caps bookings or booked minutes per day, week, month or year for one service, person, branch, room or a hand-picked team. Days are read on the business's local calendar; the database groups bookings by local day and `periodBounds` adds days up into a period (week starts Monday or Sunday). `limitsFilter` is one more `SlotFilter`; the room limit is applied where a room is picked so another room can be tried. Statuses that count: requested, booked, checked in, completed, no-show (`countedStatusesFor`, which feature 41 flips for requested).
- **Full days**: `analyseSlots` returns `fullDays`, days where a limit and nothing else removed every start. The public availability response carries them and the booking page crosses those days out and says "Fully booked" instead of "No matching times".
- **Commit** (`slot-engine/commit.ts`): the commit loads, takes advisory locks on every covering limit's period (sorted, so two requests cannot wait on each other), then loads again. The three commit paths run at the serializable level, so a request that raced a booking it could not see is retried by the caller and then meets the used-up limit.
- **Per customer** (`src/server/customer-cap.ts`): matched by email or phone (phone normalised), not by patient record; advisory locks on hashes of the contact. When "offer to move their booking" is on, the refusal queues the existing booking's confirmation email (with its manage link) to the contact on file once an hour; the response never carries a link or booking details.
- **First slot only**: a per-person, per-day post-pass; the commit widens its load to the local day to enforce it.
- **Staff override**: a fixed list of reasons (`limitOverrideReasons`); staff booking and moving accept `limitOverrideReason`; the audit row stores only that value.
- **Screens**: Limits tab in the service editor (limits, customer cap, switches), Limits for a person, a branch and a room, Team limits (hand-picked pools, until feature 53), and the override prompt on booking and moving.
- **Routes**: `GET/PUT /api/staff/limits`, `DELETE /api/staff/limits/teams/[id]` (permission `settings.manage`). Saving replaces the whole list of one owner.
- **Tables**: `booking_limits` (one owner column per scope with composite foreign keys and a check that exactly that one is set), `limit_teams`, `limit_team_members`; `services.max_active_per_customer`, `offer_reschedule_when_capped`, `first_slot_only`. All with forced row-level security.

## Done when

| Criterion | How it was checked | Result |
| --- | --- | --- |
| A service limited to 3 a day stops offering slots after the third booking that day, in the business's timezone | `limits.integration.test.ts` (database) and `limits.test.ts` (an Auckland day that is the previous UTC day) | Pass |
| Two simultaneous attempts at the last place give one booking and one clear refusal | `limits.integration.test.ts`: two practitioners on one service, three rounds, each exactly one winner and `limit_reached` for the other | Pass |
| A customer at their 2-booking cap is offered to reschedule | `limits.integration.test.ts`: refusal `customer_cap_reached`, no link in the response, a queued `appointment.reschedule_offer` message | Pass |
| A person's 20-a-day cap applies across all their services | `limits.integration.test.ts` (person cap of 2 across two services) and `limits.test.ts` | Pass |
| Staff can override with a recorded reason | `limits.integration.test.ts`: refused without a reason, booked with `owner_decision`, audit metadata is exactly that value | Pass |
| Another business cannot see or change limits | `limits.integration.test.ts` reads and writes as another tenant | Pass |
| "Daily limit reached (8 of 8)" in Why no slot | the existing explainer runs the same filters; labels added for `daily_limit_reached` and `period_limit_reached` | Pass (unit) |

## Known limits

- Saving limits is "replace the whole list": two managers saving at once, the later save wins. There is no version check on limits.
- The customer cap matches an **unverified** email or phone typed into the booking form. Feature 40's email check can verify the email; a verified-contact match for the phone waits for feature 3/4.
- Team pools are hand-picked lists until feature 53 adds real teams.
- The staff walk-in sheet does not yet show the override prompt; a full limit shows as a plain error there.
- `requested` bookings always count; feature 41's "unconfirmed holds the slot" switch will pass `requestedHoldsSlot: false` into `countedStatusesFor`.
- The screens were checked by component tests; they were not driven in a browser at 360px.
