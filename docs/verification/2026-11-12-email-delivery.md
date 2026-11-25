# Email delivery (feature 2) — 12 November 2026

What was built:

- **Provider layer** in `src/server/messaging/`:
  - the `MessageProvider` interface, with `TransientSendError` (rate limit, 5xx, network) and `PermanentSendError`;
  - the Resend adapter (`resend` 6.38.0) and a fake that sends once per idempotency key.
- **Thirteen React Email templates** in `src/emails`: the twelve in the plan plus the shared-document email. Each has typed props, a plain-text version and the business's name, accent colour and wording.
- **Appointment emails** carry `appointment.ics` and the customer's private manage link.
  - The manage token is stored sealed (`appointments.manage_token_ciphertext`, `sealed-link.ts`, a key derived from `KALENDR_RECORDS_KEY`) and opens only for the row it was sealed for.
- **The worker sends email** through the adapter:
  - The semantic key is the idempotency key.
  - The sender name is the business's name, and Reply-To is the business email (falling back to `EMAIL_REPLY_TO`).
  - The suppression list is checked before every send.
- **Account emails** (verification, invite, password reset, patient sign-in code) go through the same adapter instead of raw `fetch` calls.
- **Webhook** at `src/app/api/webhooks/resend/route.ts`:
  - svix-verified over the raw body, capped at 64 KB, and deduplicated on the svix id in `message_delivery_events`.
  - It marks notifications delivered or failed.
  - A hard bounce or a complaint adds a hash of the address to `message_suppressions`. Both new tables have forced row-level security.
- **Messages screen** shows the real status with a reason ("Bounced: the address doesn't exist.", "Not sent: this address bounced before."). The "nothing is delivered" notice is replaced by "Emails are sent in your business's name" once email is configured.
- **`pnpm email:dev`** previews the templates on port 3030.

**Not verified against the real provider.** There is no Resend account, sending domain or API key, and none was created. Every send went to the fake or to the local capture server (`e2e/support/capture-server.mjs`). Every webhook was signed with a test-only secret (`src/test/resend-webhook.ts`).

- A real send was not tested.
- A real Resend webhook was not tested.
- A real bounce or complaint was not tested.
- Domain authentication (SPF, DKIM, DMARC) was not tested.

## "Done when", one by one

| Criterion | What was done | Result |
| --- | --- | --- |
| A booking produces a captured email with a working .ics file and manage link | e2e `booking-email.spec.ts`, `email-delivery.integration.test.ts`, and a manual run on port 3202 | One email per booking. From is `"Lotus Dental Studio" <…>` and Reply-To is the business email. It has an idempotency key and `appointment.ics` (`text/calendar; method=PUBLISH`; VCALENDAR with UID, DTSTART/DTEND in UTC, SUMMARY and LOCATION). The text contains `…/manage/<token>`, and that link opens the booking. |
| A signed webhook marks it delivered | e2e, the integration test, the route tests and the manual run | An unsigned call gets **401**. A signed `email.delivered` gets **200 `applied`**, and Messages shows **Delivered**. Replaying the same svix id gets `duplicate` and changes nothing. A wrong secret, a changed body, an old timestamp or a missing id is refused. |
| A bounced address is suppressed and the next send is skipped with a clear reason | e2e, the integration test and the manual run | A signed `email.bounced` (Permanent) marks the email **Failed — Bounced: the address doesn't exist.** and adds the address hash to `message_suppressions`. The next booking to that address is **Not sent: this address bounced before.**, and the capture server receives nothing new. |
| Owner registration with `KALENDR_ALLOW_CLINIC_REGISTRATION=true` | e2e `owner-setup.spec.ts` | Passes. The verification email now goes through the adapter to the capture server, and its link signs the owner in. |
| Retries are idempotent | `email-adapter.test.ts`, `messaging.test.ts` and the capture server's key map | A retried message is sent with the same key, and the provider (fake or capture) returns the first id instead of sending again. |
| Suppression and delivery events stay inside their business | The integration test, as the real worker role | Another business's scope sees neither table's rows. |

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm check` (lint, typecheck, unit tests, `next build`) | Passed. 75 files: 575 passed, 35 skipped (database suites without a database). `/api/webhooks/resend` is in the build. |
| `scripts/verify-postgres18.sh` (PostgreSQL 18 on 5545) | Exit 0, 30 of 30, including `src/worker/email-delivery.integration.test.ts` (4 tests). |
| e2e (`KALENDR_E2E_PORT=5647`, app on 3100, capture on 3199) | 18 of 18 passed, desktop and phone, including `booking-email.spec.ts`. |
| `pnpm email:dev` | The preview server is ready on 3030 and renders `booking-confirmed` (HTTP 200). |

New tests:

- `src/server/messaging/messaging.test.ts`: templates, escaping, the fake, the Resend adapter (headers, attachments, idempotency key, error mapping), config guards, sealed links and address hashing.
- `src/server/messaging/resend-webhook.test.ts`: the svix signature and event mapping.
- `src/app/api/webhooks/resend/route.test.ts`: the route, the size cap and duplicates.
- `src/worker/email-adapter.test.ts`: the worker's email path, suppression, permanent failures and time zones.
- `src/worker/email-delivery.integration.test.ts`: the database, as the worker role.
- `e2e/booking-email.spec.ts`: the whole journey in the browser.

## Manual run (port 3202, PostgreSQL 18 container on 5602)

These ran on a production build (`next start`), with the worker in `local_capture` and the capture server on 3292.

1. **Booking:** booked Dental consultation with Dr Kavya Rao at 3:45 pm. The capture server got one email, "Your appointment with Lotus Dental Studio is booked", with `appointment.ics` and the same manage link the confirmation page shows.
2. **Delivered webhook:** unsigned got 401; signed got 200 `applied`.
3. **Bounce:** a signed `email.bounced` got 200 `applied`. A second booking to the same address at 4:15 pm was not sent.
4. **Messages:** signed in as the seeded owner. The screen showed:
   - "Booking made — Not sent: this address bounced before." for the second booking;
   - "Booking made — Failed, Bounced: the address doesn't exist." for the first;
   - "Reminder — Sent", sent before the bounce.
5. **Layout and access:**
   - At 360 px there was no horizontal scroll (`scrollWidth` 360).
   - Dark mode was checked by switching the root class, because the staff shell sets `light`. The notice, badges and reasons are readable.
   - Keyboard focus reaches the header actions, Refresh, the status tabs and the search box.

Everything started for this run was removed afterwards: the container, the app, the worker and the capture server.

## Deviations from the plan

- The webhook writes the delivery result directly, in one tenant-scoped transaction, rather than through the outbox. It finds the business through `kalendr_resolve_email_notification`, a narrow `SECURITY DEFINER` function that returns ids only.
- Manage-link sealing is in `src/server/messaging/sealed-link.ts`, separate from `record-crypto.ts`, which this feature was told not to touch.
- Nothing logs an address, name, phone number, token, subject or body. Suppression stores a SHA-256 hash of the normalised address, not the address.
