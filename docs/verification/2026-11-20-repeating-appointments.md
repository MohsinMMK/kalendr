# Repeating appointments (17): verification

Branch `claude/w2a-signin-waitlist-9af353`. Migration `0052_repeating_appointments`. Library `rrule` 2.8.1 (checked with `pnpm view rrule version`).

What was run:

- `pnpm lint`, `pnpm typecheck`, plain `pnpm test` (no database variables set), `pnpm build`.
- Integration tests against a scratch PostgreSQL 17 (port 5611, every migration applied, the web and worker roles without BYPASSRLS): `src/server/series.integration.test.ts` (fifteen cases: the four Done-when items, a skipped clash, a refused answer on the wrong day, a visit failing at commit saving nothing and the list coming back with that visit marked, one visit moved or cancelled on its own (staff, and the customer from their manage link) staying in its series, one confirmation message and not eight, the cancel-all message sent once, two saves at once giving one winner and the same key replaying, cross-business isolation with the web role, refusals, the 52 visit and 12 month caps, "all" changed from a later visit, and the confirmation through the real WhatsApp and email adapters with and without consent). The series suite also passes with `KALENDR_RECORDS_KEY`, `KALENDR_KEY_PROVIDER` and `KALENDR_LOCAL_MASTER_KEY` unset, as `scripts/verify-postgres18.sh` runs it.
- The suites that share the changed paths, run on the same scratch database: the appointment repository (the desk booking was lifted into `insertStaffAppointment`), the slot engine (commit, explain, limits), slot holds, booking sources and questions, workflows, the worker (outbox, delivery), calendar sync, staff alerts, queue, day end, reviews, availability and services admin, privacy, and features 8 and 21 (`patient-sign-in`, `waitlist-offers`, `waitlist-staff`). Those suites guard on ports 5544 and 5545, so their guards were widened to accept the scratch port for the run only and restored afterwards (nothing about the guards is in the commit). Three tests failed in that run: two email-delivery webhook tests and the patient-records code limit. They are the same three feature 21's note records as failing on the unchanged parent commit; this run did not re-check them against the parent, and this feature does not change the webhook or code-limit paths.
- The browser journey `e2e/repeating-appointments.spec.ts`, desktop and phone (both pass): a new customer is booked with "Every week" for 8 times, the list is checked, someone closes the time of one visit meanwhile, the save refuses and shows the list again with the clash, the clash is moved to another time, the whole series is saved, the customer gets exactly one confirmation listing the dates (and no per-visit "is booked" email), the series screen lists every visit, "this and the ones after it" is moved to a new time from the second visit (the first visit is untouched and the rest continue in a new series), and "all that are still ahead" is cancelled. axe found nothing serious in the repeat control, the check list, the series screen and the scope dialog (the clinic shell's own count badges are left out of the scan, as in the waitlist journey).
- `e2e/staff-day.spec.ts` and `e2e/staff-schedule.spec.ts` (the screens this feature touches) were also run on a freshly made database. Their desktop journeys pass except where axe reports `label-content-name-mismatch` on the clinic shell's own "Needs attention (N)" button once a booking exists (the finding feature 21's journey scans around; it is in shell markup this feature did not change) and one palette test that did not reach the sign-in page in time; the phone runs hit the staff sign-in limit after the earlier runs from the same address. These were not re-run on the parent commit.
- The screens were looked at in the browser at desktop width and at 360 px (repeat control, check list, booked, series screen, a visit with its repeating panel, the scope dialog as a bottom sheet): no sideways scroll, nothing cut off.

Done-when:

| Done when | Result |
| --- | --- |
| "Every Tuesday at 10 am for 8 weeks" creates 8 appointments in one action, with one clash offered an alternative | Pass (integration test and browser journey) |
| Moving "this and following" from visit 4 to Wednesday leaves visits 1 to 3 alone | Pass (integration test: visits 1 to 3 keep status, version and time; 5 Wednesdays in a new series) |
| A series crossing a clock change keeps its local time | Pass (Europe/London; the clock change is found from the zone, so the test does not go stale; every visit reads 10:00 and the UTC hour differs either side) |
| Cancelling "all" leaves completed visits untouched | Pass (completed and checked-in visits keep their version; only open visits are cancelled) |

Nothing was sent to Meta or any email provider: every message went to a capture channel or the e2e capture server.

Not verified: a real WhatsApp account and an approved `series_confirmed` template (the row is seeded as pending, so WhatsApp falls back to email until it is approved and WhatsApp is connected), PostgreSQL 18 (this run used 17).

## Known limits

- Payments (feature 23) and packages (feature 25) are later features and are not built here. A series is not paid per visit or up front, and a visit does not draw down a package yet.
- A text message has no series template, so a customer who prefers text gets email. A cancellation message is email only. WhatsApp needs the `series_confirmed` template approved at Meta.
- The preview checks each visit against what is booked now, not against the other visits of the same series. A booking limit that the series itself would use up only shows when it is saved; the save then marks the visit that went over and saves nothing.
- Booking windows still apply: a series that reaches past how far ahead the service can be booked shows those visits as "beyond the booking window" and they can only be skipped.
- "Monthly on the same date" skips a month that does not have that date (the 31st). "Monthly on the same weekday" uses the last such weekday when the first visit is on a fifth one.
- Changing "this and following" or "all" books the replacement visits with the service's usual way of meeting; a visit that was set to video or at the customer's address goes back to the default for that service. Its reason, notes and properties are copied from the visit the change started at.
- "This and following" and "all" act only on booked or requested visits that are still ahead. A booked visit whose time has passed and was never marked is left alone.
- A series needs one practitioner. "Any available" cannot repeat.
- The new booking screens read the schedule in India time, like the rest of those screens; the server expands the rule in the place's own time zone, so for a business in another zone the sentence under "Repeat" can differ by the zone's offset until those screens learn the place's zone.
- Not available in the browser preview mode (the Repeat control is hidden and the routes answer "not available in the preview").
