# Group sessions and classes (feature 18)

A class is a service with seats (`services.kind = 'class'`, `services.capacity`). A session is one dated occurrence (`class_sessions`). A customer's place is a row in `class_enrolments` (booked, waitlisted, attended, cancelled or no-show; unique per session and customer).

## The rules that keep it safe

- **The teacher and the room are held like a visit.** Creating a session writes `resource_reservations` rows (one for the teacher, one for the room when the class needs one) with `class_session_id` instead of `appointment_id`. The existing overlap-proof exclusion constraints cover them, and the slot engine already reads every confirmed reservation as busy, so a teacher cannot be given a one-to-one over their class, and a class cannot be put over a one-to-one. Each date of a new session or timetable is first checked with the same engine a booking uses (hours, time off, holidays, other visits and classes); one-to-one booking also refuses class services (`loadBookingConfiguration`).
- **The last seat is contested safely.** `enrol` runs at the default isolation in one transaction: it locks the session row (`select … for update`), counts the seats held, and takes one only when one is free. People who lose the race get `409 class_full` with `details.waitlistOpen`, and can then join the waiting list (`joinWaitlist: true`). A seat is held by a booked, attended or no-show person and by a waiting person holding a live offer.
- **The database enforces it too.** The trigger `class_enrolments_within_capacity` (`kalendr_class_capacity_guard`) takes the same session lock and refuses any write that would hold more seats than the session has (SQLSTATE 23514). It is a trigger function, so it cannot be called directly and is not in the worker-function revoke lists.
- **Order of the line** is by when someone joined (`clock_timestamp()`, not the transaction start).
- **A freed seat is offered at once.** When a person cancels, or seats are added, `offerFreeSeats` (in `src/server/class-seats.ts`, written against `Runner` so the web server and the worker share it) offers the seat to the first waiting person who has not been passed over, in the same transaction, with a 2-hour hold (never past five minutes before the start; no offers in the last 15 minutes). The message and an expiry event go through the outbox (`class.notice`, `class.offer_expire`). When the hold lapses or the person says no, they are passed over and the next person is offered the seat. A late tap is refused (`offer_over`).
- **Links.** Each place has one 256-bit token, stored as a hash (`token_hash`) with a sealed copy (purpose `class_seat`) so the worker can put the link in a message. `/class/{token}` shows the place and lets the customer cancel, take an offered seat or leave the waiting list. `kalendr_resolve_class_seat(hash)` is the narrow lookup from a token to a business (it returns the business id only).
- **Staff.** The roster has one-tap attendance (version-checked), walk-in add (a full class stays full), a message to everyone through the outbox (the text is in the payload for the worker only, never the audit trail), version-checked seat changes, and session cancel, which releases the teacher and room and tells everyone. Every staff write route calls `assertNotReadOnlyImpersonation` and needs `classes.manage` (new permission; owner, admin and receptionist). No plan gate: the plan catalogue does not name classes.
- **Timetables** reuse the rule code of repeating appointments (`expandRuleDates`), up to 52 sessions, all or nothing; sessions made together share a `series_id`.

## Known limits

- **Money.** Seats are not charged yet (the class price is shown but not collected), so cancelling a session has nothing to refund. Per-seat charging through the payments flow, and refunds or credits on cancellation (features 23 and 25), are not built.
- **Guests.** One place per customer per session; booking several seats for named guests is not built.
- **Minimum numbers.** Automatically cancelling a session with too few people is not built.
- **Reports.** Fill rate per class (feature 26) is not built.
- **"Message everyone"** goes through its own outbox event and the class email, not the workflow engine, and by email only (no approved WhatsApp or text template for class wording yet).
- **Waitlist.** Seat offers use their own small mechanism on `class_enrolments`, not feature 21's `slot_offers`, because that one is tied to appointment slots and holds.
- A repeating timetable cannot yet be edited or cancelled as a whole from one action; cancel each session.
- The sidebar shows "Classes" to every business.
