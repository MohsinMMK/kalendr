# Smart waitlist (21): verification

Branch `claude/w2a-signin-waitlist-9af353`. Migration `0051_waitlist_offers`.

What was run:

- `pnpm lint`, `pnpm typecheck`, plain `pnpm test` (no database variables set).
- Integration tests against a scratch PostgreSQL 17 with every migration applied and the web and worker roles without BYPASSRLS: `src/server/waitlist-offers.integration.test.ts` and `src/server/waitlist-staff.integration.test.ts` (match and hold inside the cancel, the time absent from the public listing while held, cascade on ignore, release after three people and inside two hours, the switch, accept through the normal booking, two links at once, the same link twice, quiet hours at 2 am, offer by hand with an Idempotency-Key, delivery through the real WhatsApp and email adapters, a bounced address passing the offer on, erasure, cross-business isolation, the public routes and their limits).
- The existing integration suites that share the changed paths (appointment repository, slot holds, slot engine, availability admin, staff alerts, queue, day end, reviews, booking questions and sources, calendar sync, privacy, the worker delivery suites, feature 8's sign-in suite) were re-run on the same scratch database. Four tests fail identically on the unchanged parent commit (calendar feed token, patient-records code limit, two email-delivery webhook tests); they are not caused by this feature. One stale expectation from feature 8 in `appointment-repository.integration.test.ts` (a reschedule now rotates the link) was updated.
- Races and rules covered by those files: two customers cancelling at the same moment (both succeed, each freeing a time; this is why `applyPatientAction` retries and why the hook rethrows a serialization failure), the booking allowance (someone moving to the earlier time is not blocked by the later one they would let go of; a customer already at the allowance is), and a tap racing the answer time running out (exactly one wins and the offers, hold and booking agree).
- The browser journey `e2e/smart-waitlist.spec.ts` (desktop and phone): two people join from the booking page, a booking is cancelled from its link, the first person is messaged, ignores it, the second is messaged, the old link is closed, the second takes it in one tap on a 360 px screen, the booking is on the schedule and the offers tab shows the trail. The join dialog and the offers tab were looked at on the phone project's 412 px screen and the desktop's 1366 px screen; the offer page was checked at 360 px (no sideways scroll, axe clean).

Nothing was sent to Meta or any email provider: every send went to a capture channel or the e2e capture server.

Not verified: a real WhatsApp account and an approved `waitlist_offer` template (the row is seeded as pending; offers go by email until it is approved and the business connects WhatsApp), the SMS channel (there is no offer template for text, so offers go by email), PostgreSQL 18 (this run used 17).

## Known limits

- Only a cancel, a move away (by the customer or staff) and a removed closed time start an offer. A closed time that is shortened or moved, and new working hours, do not (they would need the old state read before the change).
- A held time blocks staff bookings too, until it is answered or released. Staff can release it from the Offers tab ("Release to booking page").
- Staff can still set a waitlist entry to `offered` by hand from its menu; that has no offer behind it.
- The waitlist offer has no text-message template, so a customer who prefers text gets email. WhatsApp offers need the `waitlist_offer` template approved at Meta (it is seeded as pending) and the business's WhatsApp connected.
- Taking the earlier time lets the person's later booking of the same service stay out of the booking allowance for that check, so "Keep both" can leave a customer one over the allowance.
- "Cancel the later one" on the offer page goes by the offer link alone (it is the proof) and does not ask for feature 8's one-time code.
- If the worker is down for more than three minutes past an answer time, the hold lapses and the time goes public. That is the failure mode, by design.
- The customer's privacy export lists their waitlist entries; offers are not added (they hold no contact detail).
- `scripts/build-jobs.mjs` fails on `web-push` in `src/worker/push.ts`, a file this feature does not touch. The waitlist's own worker code bundles cleanly (checked with esbuild, no `server-only` or `db/client` in the bundle).
- Times on the staff Offers tab are in India time, like the rest of the follow-ups screen.
