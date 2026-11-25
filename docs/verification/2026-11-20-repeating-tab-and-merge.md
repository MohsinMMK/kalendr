# Repeating tab on the Bookings list, the merge with platform admin and billing, and the support-session guard

Branch `claude/w2a-signin-waitlist-9af353`. Migrations on this branch after the merge: `0050_customer_sign_in`, `0051_waitlist_offers`, `0052_repeating_appointments` (the trunk's `0048_platform_admin` and `0049_subscription_billing` come first).

## The merge

- `kalendr-generalization` was merged twice with real two-parent merges: first the platform admin console and billing (migrations 0048 and 0049), then the one-commit test fix that followed (`f068e06`, the public API test now expects `outside_booking_rules`).
- Conflicts kept both sides: the journal and snapshots (trunk's 0048 and 0049 untouched; ours re-derived from the trunk's 0049 snapshot by a three-way merge of the schema, so `pnpm db:generate` reports no changes), `package.json` and the lock file (`rrule` and `stripe`), the permission presets (`admin` is every key except `billing.manage`; `receptionist` keeps `series.manage` and `waitlist.manage`; `billing` gains `billing.manage`), the worker handlers (waitlist, offer expiry and series confirmation beside the billing events), the worker schedules, the worker's message sink (the plan check wraps the sink; the SMS adapter stays), the three grant lists and the docs.
- `kalendr_worker_tenants` is replaced only by our `0051` after the trunk's work: the trunk's 0048 and 0049 do not touch it, and 0051 keeps every branch (`reminder_sweep`, `hold_expiry`, `retention`, `dead_letter_report`, `request_expiry`, `reschedule_expiry`, `waitlist_sweep`). No other function or constraint is defined by both sides.
- Grant lists (`scripts/migrate.mjs`, `scripts/e2e-database.mjs`, `scripts/verify-postgres18.sh`): the runtime revoke list now has the trunk's admin and billing functions and our sign-in code delivery claim and finish functions. `kalendr_resolve_slot_offer` is a public-page resolver like `kalendr_resolve_manage_token`, so the runtime role keeps it (it is granted explicitly in `scripts/local-db.sh`, and by `GRANT EXECUTE ON ALL FUNCTIONS` elsewhere). The worker role gets every function.

## The support-session guard

`assertNotReadOnlyImpersonation` (the trunk's helper, `src/server/staff-context.ts`) now runs at the route in every write handler of the waitlist offers and series routes that checked their permission only inside the server layer: `series/[id]` POST and PATCH, `waitlist/[id]/offer` POST, `waitlist/offers/[id]` DELETE, `waitlist/services/[serviceId]` PUT and `waitlist/settings` PUT. The routes that call `requirePermission` directly (`series`, `series/preview`, `waitlist`, `waitlist/[id]`) were already guarded, because `series.manage`, `waitlist.manage` and `appointments.book` are not plain-read keys. The trunk's scan test (`src/server/staff-write-guard.test.ts`) covers every staff write route and now passes for ours; a second test names the waitlist and series routes and checks each handler and the permissions. Customer sign-in, public and customer routes are left alone.

Plan gating: the plan catalogue (`src/lib/entitlements.ts`) names online payments, custom domain, badge removal, calendar sync, reports, API and assistant. It names neither the waitlist nor repeating series, so no feature gate was added. Plan limits that apply to bookings in general (bookings a month, staff calendars read-only past the plan) are enforced inside `insertStaffAppointment` and the public commit through `assertBookingAllowed`, and a series and an accepted waitlist offer book through those functions, so they inherit them.

## The Repeating tab

See "Repeating tab" in `docs/scheduling-approval-and-policy.md` for what it does. Added: `src/lib/series-list.ts`, `src/server/series-list.ts`, `src/server/series-count.ts`, `src/app/api/staff/bookings/series/route.ts`, `src/features/clinic/bookings-series.tsx`, `src/features/clinic/series-list-data.ts`. One-line hooks in the lane C files: `workspaceTabs` and the series filter in `src/lib/bookings-list.ts`, the tab parser and filter patches in `bookings-url.ts`, the tab and the `repeatingCount` in `bookings-workspace.tsx`, `bookings-data.ts`, `bookings-views.tsx` and `saved-views.ts`, and `export` on `scopeFor` and `fromClause` in `src/server/bookings-list.ts`. The series screen's back link accepts `from=bookings`; `SeriesScopeDialog` takes only the fields it reads.

Two small accessibility fixes in lane C's filter button came out of the journey: its spoken label ("Filter, 2 on") did not contain its visible text ("Filter 2"), which the label-in-name rule flags once a filter is on; it now takes its name from what is shown. The bookings list's own test had never run with a filter on, so it had not been seen.

## What was run

Every run below is on a scratch PostgreSQL 17 (Homebrew; the project's acceptance database is 18, which was not available), port 5631, with the application's own roles without BYPASSRLS. Nothing touched `.local-db` or any other server.

- Every migration applied from scratch twice: through `scripts/e2e-database.mjs` and through `scripts/migrate.mjs` (which also proves the merged revoke list names real functions). `pnpm db:generate` reports "No schema changes".
- `pnpm check` with no database variables set: lint, typecheck, 244 test files passed (2280 tests) with 53 skipped integration files, and the production build.
- All 53 integration files on the scratch database (`pnpm vitest run integration`, one file at a time): 345 of 347 tests pass, including features 8, 21 and 17, the new list (`src/server/series-list.integration.test.ts`, eight cases: the row, done counts, running and cancelled series, filters, cursor paging, another business's series in neither list nor counts, a practitioner's own series, refused people), the appointment repository, the slot engine, the worker, platform admin, impersonation and billing. The two that fail are `src/worker/email-delivery.integration.test.ts` ("marks the email delivered from a webhook, once" and "suppresses a hard-bounced address"): they fail the same way on the trunk itself in the same database and passed in another run on this branch, so they depend on something other than this work.
- The two tests that failed in the small hours: the public API test `refuses a time that is not offered` passes (the trunk's fix `f068e06` is merged), and `holds a reminder due at 2 am until 8 am local` passes at 13:54 local time.
- One older test needed our change: `patient-records.integration.test.ts` "limits code attempts" expected five wrong codes in a row to answer `invalid_code`; feature 8's growing wait answers `code_retry_later` between them, so the test now clears the wait between attempts.
- Browser: `e2e/bookings-repeating-tab.spec.ts`, desktop and phone, both pass: a four-week series is booked through the staff route, found on the Repeating tab with its rule, status and `0 of 4`, opened from the customer name (back returns to the tab), cancelled through the which-visits dialog, gone from the running list and shown under the Cancelled status. Axe (serious and critical) is clean on the tab and on the dialog; at 360 px the page has no sideways scroll and a screenshot is attached.

## Known limits

- The Repeating tab has no bulk actions or column choice (a row is a series, not a booking). Filters that do not apply to a series stay in the address and are ignored there.
- The trunk was merged up to `f068e06`. The trunk moved once while this was being done; anything it gains after that needs merging again before this branch goes in.
- Closing the Filter menu within 300 ms of typing in the search box drops what was typed (the box commits after a pause and is torn down with the menu): found in lane C's component while writing the journey; not changed here.
