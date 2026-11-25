# Spam protection, special links, service templates, calendar wording (features 44, 45, 48, 50)

Lane C (Scheduling), wave 3. Migrations are `0057_spam_protection`, `0058_special_links`, `0059_service_templates` and `0060_calendar_wording`, chained after the trunk's 0056.

## Feature 44: spam protection

- **Blocklist.** `blocklist_entries` stores a keyed hash (HMAC with a key derived from `BETTER_AUTH_SECRET` and the business id) of the normal form of an email, phone or email domain, plus a masked hint (`r•••@gmail.com`). Gmail addresses lose dots and `+tags` and `googlemail.com` is `gmail.com`; phones are normalised the way the booking path matches them. A whole free-mail provider can't be blocked (`domain_too_broad`). Pure rules are in `src/lib/spam-contact.ts`.
- **Silent refusal.** `createAppointmentTransaction` runs every step of a real booking, then, if the contact matches the blocklist, throws `SilentRefusal` carrying the success body. The transaction rolls back (no appointment, patient, hold, message or staff alert), and a second small transaction writes one `audit_events` row (`booking.refused_blocklist`, outcome `refused`, `appointment_id` null, metadata: source and which kind matched) and stores the response under the idempotency key so a retry replays it. The customer's own slot hold is released there. The public waitlist join does the same (`waitlist.refused_blocklist`).
- **Reporting.** Staff action `report_spam` (from the booking's ⋯ menu, the bookings list row menu and the bulk bar). The booking and every open later visit of its series are cancelled by `system` with reason `spam`, with `notifyCustomer: false`, so the worker sends nothing and starts no workflow. A `booking_reports` row opens in the queue (`spam.manage` permission, owner and admin by default). **Ignore** closes it; **Block** adds the email, the phone or the email's whole domain. Removing a blocklist entry never restores cancelled bookings.
- **Spec note.** `appointments.spam_state = 'silently_refused'` is in the check constraint but never written: a refused booking leaves no row, which is what "no appointment exists" requires.

## Feature 45: special links

- **Tokens.** 256 random bits, shown once at creation, stored as a SHA-256 hash. `kalendr_resolve_special_link(hash)` (security definer, ids only) finds the business from a token, like the manage-link resolver.
- **Counting.** `spendSpecialLink` runs inside the booking transaction, after the idempotency replay check: `update special_links set used_count = used_count + 1 where … and used_count < max_uses and (expires_at is null or expires_at > now()) and revoked_at is null returning id`. No row: `410 special_link_unavailable`. A booking that fails later gives the use back. Two simultaneous attempts on a single-use link: one books, the other gets the same 410.
- **Pages.** `/l/[token]` (noindex, no referrer) books the link's one service, hidden or not; a spent, expired or revoked link shows "This link has already been used. Contact the business to book." with the phone. An unknown token is a 404.
- **Combined links.** `combined_links` (two to four people, one service, a slug). `/b/[clinicSlug]/with/[combo]` runs the normal booking flow with `combo` on the availability request: only start times every person has are offered (`src/server/combined-availability.ts`). The commit books one appointment per person in one transaction, all sharing `appointments.group_ref`; the first customer only proves their email once and the customer cap does not count the group against itself.
- **Staff screen.** Service editor → ⋯ → Special links…: one-off links (name, kind, uses, end date, copy-once link, bookings per link, revoke) and "Booked together". Permission `services.manage`.

## Feature 48: service templates

- **What a template holds.** Description, category, visibility, resource kind, lengths and prices, timing, ways of meeting (in-person means "in each copy's own branch"), look, booking page layout, contact and guests, approval and cancelling rules. It does **not** hold payment (deposit) settings, booking limits or booking forms: those keep their own tabs and stay local to each service.
- **Locks.** `service_templates.locked_fields` (names in `src/lib/service-templates.ts`). Every writer of service settings asks `assertNotLocked` (`src/server/service-template-locks.ts`): the editor's save, the older quick edits (usual length, price label), the payment price, and the old booking-mode switch. A refusal is `409 template_locked` with a plain sentence. The service editor shows a lock banner and read-only tabs.
- **Publish.** `PATCH /api/staff/service-templates/[id]` with `dryRun: true` returns the summary ("Changes prices only on 12 services. 3 services have local changes to unlocked fields, which stay."); without it, one transaction bumps the version, brings every copy's locked fields in line through the normal service save, and records the version on each copy. Before a price changes, bookings that had no price of their own are given the one in force, so existing bookings keep their price.
- **Assign and unlink.** One new service per chosen branch (offered by everyone active at that branch), or link existing services (their locked fields are brought in line at once). Unlinking keeps current settings. Deleting a template unlinks its services.
- **Where.** Settings → Service templates. Editing a template here changes the basics, lengths and prices and the locks; the other groups come from the service the template was copied from.

## Feature 50: calendar entry wording

- **Placeholders** `{service} {customer} {customer_first_name} {person} {business} {branch} {location} {length}` and any booking question by its link name (or id). Unknown ones stay as typed and are flagged. `src/lib/event-wording.ts` is pure: titles are one line and at most 200 characters (emoji safe), descriptions at most 1000, and `escapeIcsText` is the single iCalendar escape (the CalDAV writer's own copy left semicolons bare and now uses it).
- **Where it applies.** The customer's invite (emailed `.ics`, the manage-link download and the portal download) uses the customer title and the description. Staff calendars written by the worker (Google, Outlook, CalDAV) and the subscribe feed use the staff title and description. The service's own wording wins over the business-wide calendar privacy setting only when it sets a team title or "show only Busy".
- **Hide notes** empties booking-question placeholders everywhere. **Hide details** writes only `Busy: {business}`: no description, place or attendees (the fake provider records the whole payload and a test asserts it).
- **Reply-to.** `tenants.reply_to_email` and `reply_to_verified_at` are set together, only after a six-digit code sent to the address through the outbox (the booking email check's code table and rate limit) is entered. The worker uses it as Reply-To before the business email.

## Known limits

- A silently refused booking's `manageToken` is a real-looking token that opens nothing: the confirmation screen is identical, but the manage link, calendar download and "how did you hear" answer on it find no booking. A tombstone would remove that tell. A paid service's refused booking shows the payment step with an order that does not exist.
- A combined booking's appointments share `group_ref` but moving or cancelling one does not yet move or cancel the others, and the customer gets one confirmation per person.
- Special links are not required to book a hidden service: hidden still means "unlisted", as before.
- Templates do not carry payment, limits or booking forms; only fields the editor's own save writes are locked.
- The feed shows booking-question placeholders as typed, because answers are sealed and a feed can hold 2,000 visits.
- The code email for the reply-to address is the booking page's "confirm your email" message.
- Browser journeys exist for the public link pages only (`e2e/special-links.spec.ts`: single-use link, unknown link, combined link on desktop). The staff screens (spam queue, special-links sheet, templates, calendar tab, reply-to card) have no browser journey and were not looked at in a browser.
- A combined link is refused for a service that takes online payment (`combined_payment_unsupported`): one payment step can't pay for several bookings.
- A service's own team title (or "Busy only") overrides the business-wide calendar privacy setting, so someone with `settings.manage` can widen what `calendars.manage` controls. A decision for the owner of the product.
- `node scripts/build-jobs.mjs` fails on the trunk's `src/worker/push.ts` (`web-push` default import), unrelated to this lane; the feature's worker code uses the same `@/` aliases the bundler resolves for the import jobs.
- `src/server/calendar-sync.integration.test.ts` and `src/worker/email-delivery.integration.test.ts` only run on the project's own ports (5544, 5545) and were not run against the new code.
