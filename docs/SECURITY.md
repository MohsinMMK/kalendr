# Security baseline

This document describes implemented controls and required deployment controls.
It is not a certification, legal opinion, BAA, or claim of regulatory
compliance.

## Implemented in this repository

- Privacy centre (feature 7, [privacy-centre.md](privacy-centre.md)): consent is
  stored in an append-only table (`consent_records`; a trigger refuses `UPDATE` and
  `DELETE` for the web role, the worker role and the table owner, except inside
  `kalendr_erase_consent_records`). Customer data exports are zips sealed with the
  business's data key; the download link holds a 256-bit token, only its SHA-256 is
  stored, it is claimed with one atomic `UPDATE`, works once and expires after 7 days.
  Erasure anonymises in place and replaces personal fields in old audit rows through
  `kalendr_scrub_audit_personal`, a `SECURITY DEFINER` function that only the worker
  role may run, that needs an approved erasure request in the current business scope
  and that changes a fixed list of metadata keys; the audit table still has no
  `UPDATE` or `DELETE` for any application role. Export and erasure need a sign-in
  code from the last 15 minutes (customer) and, for an erasure approval or a retention
  change, a second-factor check from the last 10 minutes (staff). The breach lookup
  `kalendr_breach_affected` returns ids only and is worker-role only. Procedure:
  [INCIDENT_RUNBOOK.md](INCIDENT_RUNBOOK.md).

- PostgreSQL `ENABLE ROW LEVEL SECURITY` plus `FORCE ROW LEVEL SECURITY` on all
  tenant-owned tables.
- Tenant-qualified foreign keys and database exclusion constraints that prevent
  practitioner and physical-resource double booking.
- Better Auth 1.7.2 database sessions mounted through its official Next.js
  handler. Missing database/secret fails closed, public signup is off by
  default, verification defaults on, and production cookies are secure.
- Staff sign-in options and second factor (feature 6, see `docs/staff-sign-in.md`):
  Google and Microsoft sign-in that can only reach an already-invited person, one-time
  email links, authenticator-app codes with backup codes, and passkeys, all from Better
  Auth's plugins. A session records when it last passed a second factor
  (`auth_sessions.second_factor_at`); owners and admins cannot see data until they have
  one, and sensitive actions need a check from the last 10 minutes
  (`requireRecentStepUp`). Removing a device ends its session at once.
- Live membership authorization for staff appointment changes. Practitioners
  may change only appointments assigned to the practitioner record linked to
  their auth user.
- Zod validation, 16 KiB JSON limit, strict idempotency keys, generic error
  messages, no-store API responses, optimistic versions, hashed manage tokens,
  and transaction-bound audit/outbox writes.
- CSP, HSTS, referrer policy, permissions policy, MIME sniffing protection,
  explicit admin `X-Frame-Options: DENY`, and an intentionally separate booking
  frame policy.
- The embed loader uses an exact target origin and validates sender origin,
  sender window, nonce, protocol version, and payload shape. Completion events
  contain only an opaque appointment reference.
- Form answers and notification destinations have ciphertext-only schema
  fields. No unwrapped encryption key belongs in PostgreSQL, and no key at all in
  source control.
- Booking form answers are checked on the server against the stored form
  definition and sealed with the business's data key before they are saved. Staff
  read them only on the appointment page; each read is written to the audit log
  as `form_response.viewed`. Answers never go into notifications, the outbox,
  or the activity log. In production, a booking that carries a form fails with
  `records_unavailable` when keys are not set up.
- Customer portal sign-in by one-time code (the patient portal for healthcare and dental): codes are HMAC-hashed with
  `BETTER_AUTH_SECRET`, last 10 minutes, and allow 5 attempts per code and 5
  codes per contact per hour. Responses don't reveal whether a contact is known.
  Sessions are opaque, stored hashed, last 24 hours, and are separate from staff
  sessions (`__Host-kalendr_patient`, HttpOnly, SameSite=Lax, Secure in production).
- Portal access is computed from the verified contact on each request, so
  changing a contact on the business's record removes access. Documents need a
  second check: date of birth (locked after 5 failures) or staff confirmation
  after checking ID.
- Visit records: title, body, file name and file contents are AES-256-GCM
  encrypted with the business's own data key (envelope encryption, feature 10).
  Uploads are limited to PDF, PNG and JPEG by file signature, up to 15 MB, and are
  served with `no-store` and `nosniff` through audited routes.
- Protected storage (feature 10):
  - Envelope encryption. Each business has its own 256-bit data key in
    `tenant_data_keys`, stored only wrapped by a master key: AWS KMS in
    production (`KALENDR_KEY_PROVIDER=kms`) or a local key for development and
    tests. Every ciphertext carries its key version, and each encrypted record,
    file, picture and form answer has a `key_version` column beside it. The business id and key version are bound
    into each ciphertext, so a value copied to another business or relabelled
    to another version does not open. Records written before feature 10 are
    version 0 and still open with `KALENDR_RECORDS_KEY`.
  - Rotation. A business's key is replaced once a year by the worker, or at once
    by an owner or admin (Settings → Data protection, audited as
    `security.keys.rotated`). New writes use the new key; the re-encryption job
    moves older rows and files forward in batches and then retires old versions.
    Once version 0 is retired for a business, the server-wide key no longer
    opens anything of that business.
  - Files go to a private S3 bucket (`KALENDR_FILE_STORE=s3`) under
    `tenant/{tenantId}/{kind}/{id}`, already encrypted. Versioning is on, public
    access is blocked, and there are no public or presigned links: every file is
    read through an audited route. `scripts/s3-bucket.mjs --check` verifies the
    bucket.
  - Virus checks. Every record file, business picture and staff photo is
    checked by ClamAV before anyone can open or share it (`scan_status`
    pending, clean, infected). A pending record file returns 409 `file_pending`
    and the screen shows "Checking file…". An infected file is deleted with
    every bucket version, returns 410 `file_infected`, is marked "Removed — a
    virus was found" in the list, and an audit row `record.file.infected`
    names the uploader. In production with no scanner, uploads are refused
    (503 `scanner_unavailable`).
  - Business pictures and staff photos moved out of database rows into the
    encrypted file store (a backfill job moves existing ones).
  - Other features' secrets (OAuth tokens, payment keys, webhook secrets) use
    the same per-business key through `src/server/keys/secrets.ts`, bound to
    their purpose.
- Calendar sync (feature 16). Logins (refresh tokens, Apple app-specific passwords) are sealed per business and purpose, re-encrypted on key rotation, never logged. OAuth `state` is HMAC-signed, expires in 10 minutes and must match a single-use httpOnly cookie and the signed-in staff member. The only outside call in a request is the code exchange in the OAuth callback. Webhooks (`/api/webhooks/google-calendar`, `/api/webhooks/microsoft-graph`) follow the five steps: raw body, constant-time compare of `CALENDAR_WEBHOOK_TOKEN` (Microsoft's `validationToken` handshake is echoed first), dedupe in `calendar_webhook_events`, one transaction for dedupe plus outbox row, fast 200. Only start, end and event id are stored from a person's calendar. The `.ics` feed address is a 256-bit token stored as a SHA-256 hash.
- Records exist only when the business's records feature is on (by default,
  healthcare and dental); with it off, the records routes refuse. Records are
  limited to owner, admin and practitioner roles, with practitioners
  scoped to their own patients. Receptionist, billing and read-only roles get
  403. Each staff and patient view, file open and change is written to the
  access log.

## Deployment requirements

1. Run migrations as a privileged migration identity. Run the web app and the
   worker as two separate non-owner roles (`kalendr_app`, `kalendr_worker`), both
   `NOSUPERUSER NOBYPASSRLS`. Grant them only the required tables and sequences,
   and the definer functions listed below. Test RLS using those exact roles; the
   local Compose superuser does not prove isolation.
2. Generate `BETTER_AUTH_SECRET` from at least 32 random bytes and store it in a
   secrets manager. Rotate through a rehearsed session-invalidation process.
   Set exact `BETTER_AUTH_URL` and trusted origins. Never put a staff auth flow
   on a business custom domain or inside an iframe.
3. Terminate TLS at a maintained reverse proxy. Set `TRUSTED_PROXY_HOPS` to the
   number of proxies that append to `X-Forwarded-For` (production refuses to start
   without it); the request limits key on that address. The limits themselves live
   in PostgreSQL (`rate_limit_buckets`), are shared by every app server and survive
   restarts; every rule is in `src/server/rate-limit-rules.ts`. Set
   `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to turn on the bot check, which
   is asked for only on a second sign-up, code request or booking from one network
   by someone not signed in. Keep edge request-size limits and abuse monitoring in
   front of the app; refused requests log `"event":"rate_limit.refused"` with the
   rule name.
4. Keep `KALENDR_BOOKING_FRAME_ANCESTORS` to reviewed exact HTTPS origins. Do not
   use `*`. Prefer emitting a per-tenant CSP at the edge after hostname and TLS
   activation. A business website must allow the Kalendr origin in its own
   `frame-src` and the loader origin in `script-src`.
5. `KALENDR_PREVIEW_MODE` must be absent/false in production. Do not load demo
   customers or predictable demo manage tokens into a real tenant.
6. Use envelope encryption backed by a KMS for form responses, notification
   destinations, provider OAuth refresh tokens, and any other sensitive value.
   Set `KALENDR_KEY_PROVIDER=kms` with `KMS_KEY_ID` and `KMS_REGION` in
   production; the local provider is for development and tests. Keep
   `KALENDR_RECORDS_KEY` set until every business's version 0 is retired (the
   Data protection screen shows "All on the current key"). Set
   `KALENDR_FILE_STORE=s3` and `CLAMAV_HOST`; see
   [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md) for bucket and KMS
   permissions.
7. Keep PHI/PII, manage tokens, auth/session tokens, message bodies, form
   answers, and provider payloads out of logs, traces, analytics, error
   reporting, URLs, and metric labels. Redact at source and at the telemetry
   collector.
8. Verify webhook signatures against the raw body, enforce timestamp tolerance,
   store unique `(provider, event_id)`, acknowledge quickly, and process through
   the outbox worker. Assume duplicate and out-of-order delivery.
9. Encrypt backups, enable point-in-time recovery, restrict operators, audit
   access, define retention/deletion holds, and perform restore drills. A backup
   that has never been restored is not a recovery control.
10. Pin images and dependencies, scan them, subscribe to Next.js/Better Auth/
    PostgreSQL/provider advisories, deploy one web/worker SHA, and use
    expand-contract migrations for rolling releases.

## Database grant shape

Use provider-specific role management and replace `<runtime_role>` with an
already-created non-owner login. Do not execute a blanket grant without first
reviewing the table list for the enabled product modules.

```sql
GRANT USAGE ON SCHEMA public TO <runtime_role>;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO <runtime_role>;
REVOKE UPDATE, DELETE ON TABLE audit_events FROM <runtime_role>;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO <runtime_role>;
GRANT EXECUTE ON FUNCTION kalendr_resolve_tenant(text, text) TO <runtime_role>;
GRANT EXECUTE ON FUNCTION kalendr_resolve_manage_token(text) TO <runtime_role>;
GRANT EXECUTE ON FUNCTION kalendr_resolve_staff_appointment(text, text) TO <runtime_role>;
GRANT EXECUTE ON FUNCTION kalendr_portal_people(text) TO <runtime_role>;
GRANT EXECUTE ON FUNCTION kalendr_resolve_staff_memberships(text) TO <runtime_role>;
GRANT EXECUTE ON FUNCTION kalendr_resolve_staff_access(text) TO <runtime_role>;
GRANT EXECUTE ON FUNCTION kalendr_resolve_queue_display(text) TO <runtime_role>;
GRANT EXECUTE ON FUNCTION kalendr_resolve_queue_ticket(text) TO <runtime_role>;
GRANT EXECUTE ON FUNCTION kalendr_resolve_data_export(text) TO <runtime_role>;
GRANT EXECUTE ON FUNCTION kalendr_schema_version() TO <runtime_role>;
```

The worker-only functions from the privacy centre, `kalendr_erase_consent_records(text, text)`,
`kalendr_scrub_audit_personal(text, text[])` and `kalendr_breach_affected(timestamptz, timestamptz)`,
are revoked from `PUBLIC` by the migration. Where the runtime role is given `EXECUTE` on all
functions, revoke these three from it as `kalendr_claim_outbox` is (see `scripts/migrate.mjs`).

The queue links (migration `0024_queue_screens`) add two definer resolvers.
`kalendr_resolve_queue_display(hash)` maps a waiting-room screen link to its tenant
and location while the link is not revoked; a new link revokes the old one.
`kalendr_resolve_queue_ticket(hash)` maps a customer's phone link to its ticket,
and only on the ticket's own local day, so links end at midnight. Both take the
SHA-256 of a 256-bit token, never the token itself, and return nothing for a
suspended business. The screen shows token numbers and practitioner names only;
the phone page shows one ticket and can change only its "tell me when I'm next"
flag.

`kalendr_schema_version()` (migration `0014_observability`) is a security-definer
function that returns one number, the timestamp of the newest applied migration,
so `/api/ready` can tell whether the database is behind the deployed code without
granting the runtime role any access to the `drizzle` schema. It reads no tenant
rows. The release step (`node dist/migrate.mjs`, see `docs/OPERATIONS.md`) applies
the grants above after migrating.

The worker (migration `0015_production_worker`) has three more definer functions.
Only `kalendr_worker` may call them; the release step revokes them from the
runtime role:

```sql
GRANT EXECUTE ON FUNCTION kalendr_claim_outbox(text, integer) TO <worker_role>;
GRANT EXECUTE ON FUNCTION kalendr_worker_tenants(text) TO <worker_role>;
GRANT EXECUTE ON FUNCTION kalendr_outbox_health() TO <worker_role>;
```

What each one returns:

- `kalendr_claim_outbox` leases up to 100 due outbox rows (`FOR UPDATE SKIP
  LOCKED`, 60-second lease) and returns `(tenant_id, id)` only.
- `kalendr_worker_tenants` returns the business ids a timed job has work for.
- `kalendr_outbox_health` returns four counts.

None of them returns a payload, name, address or message. The worker reads and
writes every row after it sets `app.tenant_id` in its own transaction, so row-level
security applies to it exactly as it does to the web app.
`src/worker/outbox-worker.integration.test.ts` proves four things as the real
worker role:

- the role has no BYPASSRLS;
- it sees no appointment without a business set;
- the runtime role gets `42501` on all three functions;
- a retry from another business returns 404.

Where the provider supports it, set default privileges for future migrations
with equal care. Do not grant the runtime role ownership or `BYPASSRLS`.

## Security acceptance checklist

- Cross-tenant read/write attempts fail under the runtime role, including IDs
  copied from another business.
- One hundred concurrent requests for one practitioner/resource/time yield one
  booking and 99 `slot_unavailable` responses; replaying the winner's key
  returns the same response.
- Stale versions fail, cancel/reschedule correctly release or move both
  reservations, and audit/outbox rows commit atomically.
- DST spring gaps and fall folds are covered for every supported zone; messages
  state the business's timezone and offset.
- Manage tokens cannot appear in referrers, analytics, logs, screenshots, or
  support tools; brute-force controls and rotation/revocation are tested.
- Third-party cookies blocked: public booking still works. Forged
  `postMessage`, wildcard origins, unverified custom hosts, and framing staff
  pages all fail.
- Duplicate/out-of-order Google, Microsoft, Stripe, email, and SMS callbacks do
  not duplicate state changes or notifications.
- Backup restore, key rotation, provider-token revocation, incident response,
  and tenant export/deletion are rehearsed.

## Known foundation gaps

- The worker sends email through Resend (feature 2); SMS and WhatsApp have no
  adapter yet. Email delivery has not been tested against the real Resend
  service: no real send, webhook or bounce. The KMS
  adapter, calendar/payment providers, other webhook
  routes, distributed rate limiter, per-tenant edge CSP, and OpenTelemetry
  exporter are architecture contracts, not completed integrations.
- The static Next.js CSP currently permits inline scripts/styles required by
  the application build. Before regulated production, adopt Next.js nonce-based
  CSP or hashes and verify every route under the deployed reverse proxy.
- Protected storage (feature 10) was verified only locally, with MinIO, ClamAV
  and the local key provider. Real S3, real KMS and a production restore have
  not been run. The KMS provider is unit-tested against a stubbed client.
- Visit records have no retention or deletion schedule. Patient sign-in has a
  limit per contact but none per IP address. Do not store real patient records
  until these are closed.
- If ClamAV stays down for all 8 attempts (about 21 minutes), the scan goes to
  dead letter and the file stays pending (it never opens). `storage-health`
  logs the count; there is no screen to re-queue it yet.
- The uploader learns of an infected file from the file list and the audit log,
  not by a message (features 2–5 add messaging).
- Email (feature 2): the Resend webhook is verified with svix over the raw body,
  refuses bodies over 64 KB and timestamps more than five minutes off, and
  records each event id once. It reaches a business's rows only through the
  security-definer `kalendr_resolve_email_notification()`, which returns ids
  only. `message_suppressions` and `message_delivery_events` have forced
  row-level security and keep a SHA-256 hash of the address, never the address.
  The manage token is sealed on the booking with a key derived from
  `KALENDR_RECORDS_KEY` and bound to the business and booking, so a copied
  ciphertext opens nowhere else. Nothing logs an address, subject or body.
- Expired `rate_limit_buckets` rows are removed by
  `deleteExpiredRateLimitBuckets()`, which nothing schedules yet. Website API
  bookings sent from a business's server count against that server's address
  (`booking.ip`) until per-key API limits exist (feature 34). `frame-ancestors`
  is the operator list (`KALENDR_BOOKING_FRAME_ANCESTORS`) plus each business's
  saved sites (`tenant_embed_origins`, feature 13).
- The public manage link is a bearer credential. Add short expiry/rotation and
  customer OTP step-up where business policy or sensitivity requires it.
- Application controls do not replace vendor contracts, BAAs/DPAs, privacy
  notices/consent, lawful-basis analysis, records policy, or jurisdictional
  counsel.

Primary implementation references:
[PostgreSQL row security](https://www.postgresql.org/docs/18/ddl-rowsecurity.html),
[PostgreSQL exclusion constraints](https://www.postgresql.org/docs/18/rangetypes.html),
[Better Auth Next.js](https://better-auth.com/docs/integrations/next),
[Better Auth Drizzle](https://better-auth.com/docs/adapters/drizzle),
[MDN `frame-ancestors`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors),
and [MDN `postMessage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage).

## WhatsApp and SMS (features 3 and 4)

- WhatsApp webhook: `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, keyed with `WHATSAPP_APP_SECRET`), constant-time compare, 401 with no detail on failure or when no secret is set. `GET` answers Meta's `hub.challenge` only for the right `WHATSAPP_VERIFY_TOKEN`.
- Twilio webhook: `X-Twilio-Signature` (HMAC-SHA1 over the public URL plus sorted form fields). MSG91 delivery reports are not signed by MSG91, so the route is protected by a secret path token (`MSG91_WEBHOOK_TOKEN`), compared in constant time.
- Message text in the Inbox is sealed with the business's data key (`messages.body_ciphertext`); outbox payloads hold ids and short codes only, never a number or a body. Threads find their business from a salted hash of the customer's number.
- Short links (`/m/<code>`): the code is derived from a server key, only its hash is stored, the route is rate limited, and the redirect carries no referrer.
- Known limit: Meta has no idempotency key, so a worker crash between Meta accepting a message and the worker recording it can send a WhatsApp message twice. Not tested against the real services.

## Subscription billing webhooks (feature 14)

- `/api/webhooks/billing/razorpay`: HMAC-SHA256 of the raw body keyed with `RAZORPAY_WEBHOOK_SECRET` in `X-Razorpay-Signature`, constant-time compare; deduped on `x-razorpay-event-id`. `/api/webhooks/stripe`: `Stripe-Signature` (HMAC-SHA256 over `timestamp.body`, five-minute tolerance, constant-time compare, several `v1` values accepted during rotation). Both answer 401 with no detail on failure or when no secret is set, then record the event and an outbox row in one transaction and return 200.
- `billing_events.payload` keeps only ids, status, amounts, currency, period times and plan ids. It never holds a card, UPI address, email, phone, name or the raw body. A trigger refuses edits and deletes (only `processed_at` and `outcome` may be set); `platform_invoices` refuses any update or delete.
- Keys: `RAZORPAY_KEY_ID/SECRET`, `STRIPE_SECRET_KEY` are used only to create the checkout in a request and by the worker for plan changes; plan changes, cancel and resume are never called from a staff request except an upgrade the owner is waiting on. Details in `docs/subscription-billing.md`.

## Booking limits, holds and booking questions (features 38 to 40)

- **Tokens and codes.** A slot hold's token is 256-bit random and only its SHA-256 is stored. The email check's 6-digit code is stored as an HMAC keyed with `BETTER_AUTH_SECRET`, lives 10 minutes, allows 5 attempts, and sends are limited to 5 an hour per address and 20 an hour per network; the one-use proof that follows is also stored hashed and is consumed inside the booking transaction.
- **Sealed values.** The address and code waiting for the worker (`email_checks.delivery_sealed`) and a booking's guest list (`appointments.guest_emails_ciphertext`) are sealed with the same key family as manage links, bound to the business, the row and a purpose, and the first is cleared once sent. Neither is logged, put in audit metadata or returned by any API.
- **Customer caps.** The match on email or phone uses hashes as lock keys; a refusal never carries a manage link or any detail of the existing booking. The "move your booking instead" message goes to the contact already on file.
- **Overrides.** Staff go past a booking limit only with a fixed reason (`limitOverrideReasons`); the audit row stores that value and no free text.
- **Hidden questions.** The server runs the same visibility function as the page and drops answers to questions the customer was not shown.
- **Credentials needed in production.** The code email and guest confirmations need the email provider (`RESEND_API_KEY`, `EMAIL_FROM`) and `BETTER_AUTH_SECRET`; confirmations to phone-only customers need the WhatsApp or SMS account from features 3 and 4.


## Customer sign-in upgrade (feature 8)

- **Delivery.** Sign-in codes, step-up codes and contact-change notices are sealed into a platform table (no business id, no row-level policy, reachable only through definer functions) and sent by the worker; the request never calls WhatsApp, a text provider or email. In production with no `KALENDR_RECORDS_KEY` nothing can be sealed, so the request answers 503 instead of pretending to send. See `docs/WORKER.md`.
- **Limits.** Code requests: 5 an hour per contact, per network and per device (a random cookie, not a fingerprint; a script that drops it is still held by the other two); the bot check from feature 9 still applies. After a wrong code the next try waits 2, 4, 8, 16, then 30 seconds (stored on the code row, 429 with Retry-After; a refused try is not counted). Step-up codes have their own limits per booking (5 an hour) and per network (10 an hour), separate from sign-in codes.
- **Manage links.** `appointments.manage_token_expires_at` is kept at 30 days after `ends_at` by a trigger, and `kalendr_resolve_manage_token` ignores an expired row, so every caller (manage page, calendar file, review, video visit) is covered. The page shows "Sign in to see this booking" with no business details; the API answers 410 `manage_link_expired`. A patient-made reschedule rotates the token in the same transaction, before the outbox row, and removes the booking's short links, so the old link and the old text-message link stop and the message carries the new link.
- **Step-up.** Viewing by link is allowed. Cancel, reschedule and contact change from a link need a code sent to the phone or email on the booking, unless this device holds a portal session that belongs to this booking's customer (`kalendr_portal_people`, not just any signed-in account). A booking with a payment row always asks, and its code works once. The code and its 15-minute grant are tied to the business and booking, not to the link. The guard is in the public route handlers.
- **Devices.** Portal sessions carry a coarse device label and a remember flag (24 hours, or 30 days). Sign-out by id is scoped to the account. `created_at` is never refreshed, because `requireFreshPatientSession` reads it as the code's age.
- **Contact change.** The old contact on the channel that did not change (both, if both changed) is told that details changed; the message names the business and no new contact. Audit metadata names the fields, never the values.

## Smart waitlist (feature 21)

- **The link is the proof.** An offer link carries a 256-bit token. Only its SHA-256 is stored (`slot_offers.token_hash`); a sealed copy (AES-256-GCM, purpose `waitlist_offer`, bound to the business and offer) lets the worker build the link and is cleared once the message is sent. The token is never logged, put in the outbox, audit rows or any response. `kalendr_resolve_slot_offer` returns business and offer ids only.
- **Limits.** `offer.token` 30 an hour per link and `offer.ip` 60 an hour per network (a guesser is stopped by the network rule long before 256 bits matter); `waitlist_join.ip` 10 an hour and `waitlist_join.contact` 5 a day; the sign-up uses the booking form's honeypot, fill-time check and Turnstile when risky. All in `src/server/rate-limit-rules.ts`.
- **What the page shows.** The business, service, person, place and time, and whether a later booking exists (only its time). No customer name, contact, booking id or entry id.
- **What the offer can change.** Only the one offer the token names: taking it books that time for that entry's customer; the later booking to cancel is found on the server from the accepted offer, never named by the caller; the request body is a strict `{ action }`.
- **Staff.** New permission `waitlist.manage` (owner, admin and receptionist by default) for offering by hand, releasing a held time, the order rule and the per-service switch; the offer trail needs `appointments.book`. Each change is audited, with ids and short codes only, never a name, contact or message text. Offer by hand takes an Idempotency-Key.
- **Erasure.** An erasure deletes the customer's waitlist entries; their offers go with them through the foreign key and a trigger releases any held time. Offers hold no contact detail.


## Repeating appointments (feature 17)

- **Permission.** New key `series.manage` (owner, admin and receptionist by default) for booking, changing and cancelling a series. Changing one visit of a series needs only the usual booking permission. Customers can cancel or move one visit from their own link; they cannot touch the series.
- **Every visit is a booking.** Each visit goes through the slot engine check, booking limits and the customer cap exactly like a desk booking, so a series cannot be used to get around a rule. A walk-in cannot repeat.
- **What is stored.** The rule, dates, ids and a version. No name, contact or note is stored on the series. The audit rows (`series.created`, `series.changed`, `series.cancelled`) hold ids and counts only; free text never reaches them.
- **Idempotency and versions.** Saving a series and changing or cancelling one take an `Idempotency-Key`; a change checks the series version and answers `version_conflict` when it is stale.
- **Isolation.** `appointment_series` has forced row-level security and composite foreign keys, and a visit can only point at a series in its own business. The cross-business test is `src/server/series.integration.test.ts`.
- **Erasure.** The confirmation event rides on the first visit's appointment, so an erasure removes pending ones and clears delivered payloads like any other appointment event. The series row holds nothing personal.

## Platform admin console (feature 15)

Kalendr's operators reach other businesses only through `SECURITY DEFINER` functions named `admin_*` (migration `0048_platform_admin (and 0049_subscription_billing)`). Each takes the caller's user id first and raises unless that user is an active row in `platform_admins` with a suitable role (`kalendr_admin_require`). `platform_admins` and `platform_audit_events` have forced row-level security with no policy, so the runtime role cannot read or write them; `platform_audit_events` is append-only by trigger. `impersonation_sessions` is readable by the business it belongs to (its Activity log) and by nothing else.

- Second factor is mandatory for every operator (authenticator app or passkey, checked within 12 hours; write actions within 10 minutes). The console answers `404 not_found` to anyone else, including on a wrong host or IP when `KALENDR_ADMIN_HOST` or `KALENDR_ADMIN_IP_ALLOWLIST` is set, and does not exist in preview mode.
- "View as this business": 256-bit token stored only as SHA-256, cookie HttpOnly and SameSite=Strict, 30 minutes, read-only unless a super operator asks for write, every viewed path recorded, session listed in the business's own Activity log.
- Operator data never includes customer names, contacts, message bodies or record contents. See `docs/platform-admin.md`.

## Public API and webhooks (feature 34)

- API keys are `kal_live_` or `kal_test_` plus 256 random bits. Only the SHA-256 hash is stored, with a six-character visible prefix. Only the owner can create a key, and only right after a second-factor check. The key is shown once. A business may hold 25 active keys, expiry is at most two years, and a test key cannot hold a write scope. Revoking takes effect on the next request.
- A `/api/v1` request resolves the key through `kalendr_resolve_api_key` (ids and scopes only), counts against 600 requests a minute per key (bad keys: 60 a minute per network), then runs through `withTenant` with explicit tenant filters as a second lock. Writes call the staff booking functions, so the slot check, limits, idempotency and audit are the app's own. Audit rows carry `actor_type` `api_key` with the key id and prefix, never free text. The manage token is never returned. `openapi.json` is public and holds nothing private; `/developers` loads no outside script.
- Webhook secrets (`whsec_` + 256 bits) are sealed with the business's data key (purpose `webhook.endpoint`), shown once, never logged. Each delivery carries `X-Kalendr-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`; receivers verify in constant time and reject timestamps more than 5 minutes off (`verifyWebhookSignature`).
- Addresses must be HTTPS on port 443 or 8443, with no credentials or internal host names and no private, loopback, link-local, CGNAT, multicast or reserved IP (IPv4-mapped IPv6 included). That is checked at save time with no network call. The worker resolves the name just before each delivery, refuses any non-public answer, connects to the checked address, never follows redirects, times out at 10 s and discards the reply body. Nothing loosens the guard. The log keeps a status code, duration and a fixed error code only. Payloads carry ids, times, amounts and the version, no names or contact details.
- Known gap: `webhook_endpoints.secret_ciphertext` is not yet in the key re-encryption job (`kalendr_storage_tenants`); retired keys still open, so nothing breaks. Add it when that function is next changed.

## Data import (feature 12)

The uploaded file is sealed with the business's data key at `tenant/{id}/import/{jobId}`. The type comes from the bytes, not the name. Macro workbooks, workbooks that expand past 80 MB, files over 10 MB, 20,000 rows or 60 columns are refused; cells are cut at 1,000 characters. No cell value is stored or logged: `import_rows` keeps a status, a fixed error code, a field name and a record id, and audit rows carry ids and counts. Imported customers get no messaging consent; consent is recorded only when a column supplies it and the owner ticks the confirmation box. The error file is rebuilt from the encrypted file at request time and neutralises cells starting with `=`, `+`, `-`, `@`, tab or return. `kalendr_import_tenants()` returns ids only and is not callable by the web role. Undo removes only rows the import created that have not been used or edited since; filled-in blanks on existing customers are not reverted.

## Online payments (feature 23)

- Each business connects its own payment account; Kalendr never holds customer money. Keys are sealed with the business's data key (`payments.secret`, `payments.webhook-secret`) and re-encrypted by the storage job when the key rotates. Changing the account needs a recent second-factor check (the built-in test account excepted).
- Webhooks: the raw body is verified with HMAC and a constant-time compare (Stripe also rejects signatures older than five minutes), recorded once per provider event id, and handled by the worker. An unknown address and a bad signature give the same 401. Only ids, amounts and statuses of an event are stored, never the payer's email or phone.
- The amount charged is worked out on the server from the service and the booking's stored terms; the browser sends no amount. A captured payment whose amount or currency differs from the order is not written to the ledger; it goes to the owner's mismatch list.
- No card, UPI or bank details are stored anywhere. Money rows are insert-only (database trigger); a refund is its own row. Free text from staff (refund reasons) stays out of audit metadata.
- The CSP allows Razorpay's script and frame on the booking pages only (`/book`, `/manage`, `/pay`).

## Embeds, short links and tracking (feature 52)

- Embed messages carry ids and times only; the booking page drops every other field and talks only to the origin that opened it, after a nonce handshake. The loader checks origin and window on every message and follows a redirect only to http(s) addresses without credentials.
- The thank-you redirect carries the booking id, and with "pass details" also the service, start and a signed summary (HMAC-SHA256, 15 minutes, verified in constant time). Never a name, email or phone.
- Tracking: the owner enters ids that the database also checks; the page adds each provider's snippet on `/book` pages only, after consent that starts undecided. The CSP lists exactly the providers' hosts, on booking pages only.
- Short links: seven random characters, counted without storing addresses; the target is built from fixed pieces and constrained by a check, so a link cannot leave the business's booking pages. The lookup is a definer function that returns one path.

## Staff notifications (feature 56)

Push and email bodies carry the time, service and customer's first name only. Alerts reach only people who could open the appointment under their permissions; a practitioner hears about their own. Free text (notes, messages, reviews) never goes into an alert or audit row.
## Own web address and branding (feature 13)

- Host routing applies only when `KALENDR_CNAME_TARGET` is set, and never to `/api/health` and `/api/ready`. A host that is not Kalendr's own is a business's address only if `kalendr_domain_lookup` says so (status `active`, verified, records not missing for more than 7 days). Anything else is a plain 404 with no mention of Kalendr; a database outage is a 503, never cached as "no such business". Only public pages and `/api/public` and `/api/portal` are served there: staff sign-in, staff, admin, internal, v1 and webhook routes are refused, so staff sign in on Kalendr's own address only.
- Ownership proof is a CNAME to `KALENDR_CNAME_TARGET` plus a TXT at `_kalendr-verify.<host>` with a 256-bit token; only its SHA-256 is stored and the comparison is constant time. DNS lookups run in the worker with a timeout, never in a request. A failed lookup is never treated as a missing record.
- `GET /api/internal/domain-check` answers 200 only for a live address, with no body, rate limited, with an optional shared token (`KALENDR_DOMAIN_CHECK_TOKEN`, constant-time compare). The host in front must ask it before issuing a certificate.
- The hostname rules refuse IPs, ports, single labels, Kalendr's own hosts and local names. An unverified claim never blocks the rightful owner and a live address can never be taken.
- Saved embed origins are https origins only, normalised by `new URL().origin`, constrained in the database and re-checked when the header is built, so a row cannot add a directive or a wildcard. The per-business `frame-ancestors` follows the page that renders.
- The accent colour reaches inline CSS and emails only as `#rrggbb` (zod on write, `parseBrand` on every read, `safeAccent` in emails). Uploaded logos and covers keep feature 10's type, size, dimension and virus checks.
- Audit rows for domains and embed sites carry only the host or origin; branding rows carry flags and colour-changed booleans, no free text.

## Onboarding (feature 11)

- Every new staff write route (`/api/staff/onboarding/*`) checks the read-only support session and `settings.manage`. Test and sample rows are removed by `kalendr_purge_test_rows`, an owner-run definer function that refuses to run outside the business in scope; it unlinks audit rows from the removed bookings instead of deleting them.
- The test booking panel opens the business's own page in a same-origin frame with the owner's own name, email and number in the frame's address (the booking page's existing prefill). They are not sent anywhere else, not logged, and never put in audit metadata.
- Sample customers use reserved fake contact details and no message is sent for a sample booking. Onboarding emails to the owner carry counts and links only.

## Invoices, packages and coupons (features 24 and 25)

- Money rows are never edited. Triggers refuse any update or delete of an invoice, invoice line, credit note, credit note line, invoice document or link, of every credit ledger row and of every applied discount; a coupon redemption can only have its release time set. Invoice numbers are gapless and drawn inside the issuing transaction.
- Invoice links are 256-bit tokens stored as SHA-256 hashes (`invoice_links`), looked up through `kalendr_resolve_invoice_link` (ids only), rate-limited with the payments rule, answered identically when unknown or expired, served with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. The PDF is sealed with the business's data key. Invoice PDFs are rendered in the worker, never in a request.
- Audit rows for invoices, credit notes, packages and coupons hold ids and amounts only. The buyer's name, the credit note reason and the credit adjustment reason are free text or personal data and stay out of them. CSV cells that start with `=`, `+`, `-` or `@` are written as text.
- The public coupon check answers every failure the same way and is limited to 20 attempts per 10 minutes per address; customer-specific rules are enforced at booking and never explained to a customer. Package credits are never spent by a public booking.
- Card numbers, UPI ids and bank details are never stored: the ledger holds the method only.

## Booking assistant (feature 30)

The model can only propose; the customer's own confirm (a button the server drew, or a bare "yes" right after a proposal) makes a change, in code, through the booking engine. Customer text is sanitised and treated as data; tools take no tenant or business and refuse extra fields; a move or cancel needs a verified phone and a booking id the chat itself showed. The code for a phone check goes to its own box and is never stored in the chat. Emergency and advice phrasing are answered by a fixed reply before any model runs. Each business and each customer is rate limited, and a monthly token cap is checked before every model call. Nothing logs a message, name or number. Details: [booking-assistant.md](booking-assistant.md).
## Company sign-in and directory sync (feature 53)

- SAML replies must answer a request this server made (consumed on use), carry a signed assertion verified against the connection's certificate, name our entity as audience and the provider's entity as issuer, and be inside their time window. The address in the reply must be on the connection's verified domain. A reply never creates a session directly: it creates a 256-bit one-time ticket (hashed, two minutes, deleted on use).
- Company sign-in can be required for a domain; everything else that makes a session is then refused for those people, except the one break-glass owner, who must have a second factor. Refusals are audited with ids only.
- Directory tokens (`kscim_` plus 256 random bits) are stored as SHA-256 hashes, shown once, rate limited per token and per network, and refused on plans without the enterprise feature. A directory can never change an owner, and never deletes bookings, records or history.
- OIDC client secrets are sealed with the business's data key and never returned by any route.
## Customer profiles and campaigns (features 27 and 28)

- Every new table has forced row-level security with the tenant policy, and a cross-business test. The new tenant lists `kalendr_crm_tenants` and `kalendr_campaign_tenants` return ids only and are revoked from the web role; `kalendr_resolve_unsubscribe` returns ids only and is the one way from a link's token hash to a business.
- Segment filters are validated JSON compiled to bound parameters; no SQL is built from filter text. Staff notes, block reasons and the answers in extra fields are free text and stay out of audit metadata, logs and the outbox.
- A merge needs `customers.merge` and a second-factor check from the last 10 minutes. The merged profile's phone and email are sealed (`customer.merge-snapshot`) with the business's data key, re-encrypted with key rotation, and dropped after 30 days. Payments, invoices and coupon uses are never edited by a merge.
- Marketing is sent only with a recorded yes, never to anyone under 18, and every message carries an unsubscribe link that works without signing in. Unsubscribe tokens are 256-bit random values stored as SHA-256 hashes; the public route is rate limited (`unsubscribe.ip`), answers a dead token like any other, and redirects to a page that shows nothing about the business or the customer.
- The CSP is unchanged: the unsubscribe page is a normal server-rendered page with no scripts of its own.


## Search and discovery (feature 29)

- Staff search and the public directory and sitemap read through `SECURITY DEFINER` functions (migration 0074), because the app role cannot use text indexes under forced row-level security. `kalendr_staff_search` takes the business only from `app.tenant_id` and returns nothing without it; the server passes only the kinds the person's role may open, and a team member's own profile id for "own records only". The directory and sitemap functions return public business facts and slugs for listed, running businesses only.
- Search text is never logged. A failed search is rethrown without the database's message (which repeats the typed text) before it reaches the error reporter.
- A business is not indexed until its owner turns listing on. Listing changes are refused in a read-only support session and write an activity row with field names only.
