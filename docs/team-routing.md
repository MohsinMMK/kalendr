# Team routing (feature 20)

A customer who does not care who they see picks "Anyone available". The booking page shows the **union** of everyone's free time for the service, each time once. The person is chosen **inside the booking transaction**, not when the time was shown, because the person who was free may have been taken since.

## How it works

- **Pooled availability.** `GET /api/public/availability?practitionerId=anyone` runs the normal slot engine for everyone who offers the service at the place and returns each start once, with `practitionerId: "anyone"`. The answer also carries `nextByPerson` (each person's next free time) so the provider step can say "Earliest: …" and "Next free: …". `first_available` still returns per-person slots for the staff sheets, the waitlist and the public API.
- **Choosing the person.** `src/server/routing.ts` locks the pool (`practitioners … order by id for update`, a fixed order so two bookings never wait in a circle), finds who is free for the whole visit with the same rules the page used, and ranks them with the pure `rankAssignees` (`src/lib/routing-rank.ts`). Order: the returning customer's own person (only when the service asks), a cover person for someone's leave, highest `priority` (not for round robin), furthest below fair share, booked least recently, then id. Fair share is `weight / total weight × (bookings + 1) − bookings`. Bookings are counted by when they were **made** in the last 30 days, for the same service. A team member who joined in the last 30 days is counted as having the team's average, so they are not flooded.
- **Contention.** Two customers on the same "anyone" time queue on the pool lock; the one who waited re-reads and gets the next person. If the database exclusion constraint still fires (`23P01`) the whole booking is retried (up to 8 times) on a fresh snapshot, so it falls through to the next free person. It fails with `slot_unavailable` only when nobody is free.
- **Holds.** An "anyone" hold takes the person routing would pick and keeps that person free for the customer; the booking that follows with the hold token gets the same person.
- **Service setting.** `services.assignment` is `customer_chooses` (default; "Anyone available" is the first tile), `any_available` (the person screen is skipped; priority, then fair share) or `round_robin` (fair share only). `services.prefer_returning_person` gives a returning customer the person they saw last time when they are free. `practitioner_services.priority` (0–100) and `weight` (1–100) are edited in the service editor's Team routing tab (`GET/PUT /api/staff/routing/services/{id}`, version-checked, audited with ids and numbers only). Editing a service's people no longer resets these.
- **Time off and cover.** `time_off` (already in the schema) closes a person's slots and names a cover. While it is on, new "anyone" bookings go to the cover. The Time off panel's "Move bookings to <cover>" action (`POST /api/staff/routing/leave-reassign`, `Idempotency-Key`) moves each booking inside the leave through the bookings list's `reassignIn`: same booking, time and manage link, version checked, the customer is told (the email names the new person). Bookings the cover is not free for stay put and are listed as **Needs a person** (derived: still with the person, inside their time off) with a "Give to" picker.
- **Share on the Team screen.** `GET /api/staff/routing/share?month=` — bookings per person for the month against the share their weights give them.

## Known limits

- A request for a specific person cannot yet carry its own price or deposit (spec item 8, needs feature 23's pricing tied to people).
- The "message the customer" text for WhatsApp and text says "a different team member" without the name; the email names them.
- "Needs a person" is a derived list; there is no separate queue or alert for it.
- Routing counts bookings per service. The Team screen share counts all services.
- In preview mode "anyone" falls back to per-person demo slots.
