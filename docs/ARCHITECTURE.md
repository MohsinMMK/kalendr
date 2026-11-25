# Kalendr architecture decision record

Status: accepted foundation, 31 August 2026.

## Decision

Kalendr starts as a portable TypeScript modular monolith: a Next.js 16.3.3 Node
web/API process, a separate worker built from the same image, and PostgreSQL
18.6 as the scheduling authority. The checked-in runtime uses React 19.2.8,
Better Auth 1.7.2, Drizzle ORM 0.45.2, Zod 4.5.4, and Node 24 LTS in production.
Pin these versions and review release/security notes before upgrading; the local
machine may run a newer Node, but production should stay on an Active or
Maintenance LTS line.

This keeps the first deployment inexpensive and debuggable while preserving
clean module boundaries for scheduling, customer self-service, notifications,
calendar adapters, and payments. Do not introduce Redis, Kafka, or Kubernetes
until measured queue or scaling requirements justify them.

## Request and tenancy boundaries

Every tenant-owned table carries `tenant_id`. Child references use
`(tenant_id, id)` foreign keys where the relationship permits it, so a valid ID
from one business cannot be attached to a record from another. The migration
enables and forces PostgreSQL row-level security on every tenant table.

The runtime database login must be a non-owner with `NOSUPERUSER NOBYPASSRLS`.
It resolves a business slug, active custom hostname, manage-token hash, or
authorized staff appointment through one of three narrowly scoped
`SECURITY DEFINER` functions, then calls `set_config('app.tenant_id', ..., true)`
inside the same transaction as the protected query. The application never
trusts a client-supplied tenant header.

Staff identity is global Better Auth identity; authorization is always a live
membership check. Better Auth's Next.js handler is mounted at
`/api/auth/[...all]`. Email/password signup is disabled unless explicitly
enabled, email verification defaults on, cookies are secure in production, and
auth endpoints fail closed when the database or secret is absent.

Sign-in options and the second factor (feature 6) add three global auth tables
(`auth_two_factors`, `auth_passkeys`, `auth_known_devices`), a `two_factor_enabled`
flag on the user, and `second_factor_at` on the session. The staff context checks the
second factor per session, not per user, because Better Auth only challenges password
sign-ins. See `docs/staff-sign-in.md`.

## Privacy centre tables (feature 7)

Migration `drizzle/0039_privacy_centre.sql` (number may change at merge). All five tables have `tenant_id`, a
`(tenant_id, id)` unique key, composite foreign keys and forced row-level security. Details in
[privacy-centre.md](privacy-centre.md).

| Table | Purpose |
| --- | --- |
| `consent_records` | Append-only consent history (trigger refuses update and delete). |
| `privacy_notices` | A business's own notice text per version and language. |
| `data_requests` | Download, erasure and correction requests with a 90-day due date and a `version`. |
| `data_exports` | One built export per request; only the SHA-256 of the one-time token is stored. |
| `retention_policies` | The owner's retention periods; defaults live in code. |

`patients` gains guardian columns (contact sealed with the business key) and `erased_at`. New definer functions:
`kalendr_resolve_data_export` (web role), `kalendr_erase_consent_records`, `kalendr_scrub_audit_personal`,
`kalendr_breach_affected` (worker role only). The file store accepts a third key kind, `export`.

## Business profiles and booking forms

Kalendr serves any appointment-led business. Each `tenants` row carries a
`business_type` (default `healthcare`, so older clinics are unchanged), plus
`terminology` and `features` overrides (migration `0009_business_profiles`).
`resolveBusinessProfile` in `src/lib/terminology.ts` merges the preset from
`src/lib/business-types.ts` with those overrides and returns the words and
feature flags. The resolved profile travels in the staff snapshot, the public
catalog, and the portal payload; server code (messages, calendar files, API
errors) resolves it from the tenant. Feature flags gate both the screens and
the API: for example, the records routes call `requireFeature(context,
"records")` and refuse when records are off. Internal names stay as they were:
tables, columns, routes, and source folders keep their clinic names
(`patients`, `practitioners`, `src/features/clinic/`).

Booking forms live in `form_definitions` and `form_definition_services`
(migration `0010_booking_forms`, both with the per-tenant row-level security
policy). Editing a published form creates a new version; responses keep the
version they were given. The server validates answers against the stored
definition and stores them encrypted in the existing `forms` table with the
records key (`KALENDR_RECORDS_KEY`). Answers are read only on the staff
appointment page, each read is audited as `form_response.viewed`, and answers
never enter notifications, the outbox, or the activity log.

## Scheduling consistency

Every slot rule lives in one pure function, `offerableSlots(input)`, in
`src/server/slot-engine/`. `load.ts` reads what it needs inside the caller's
transaction (service rules, working hours, bookings, blocks, resources) and the pure
files apply the rules: `working-hours.ts` (a chain of small steps per person and day),
`service-rules.ts` (grid, buffers, notice, window), and the filter list in
`offerable-slots.ts`. The public availability route, the staff openings list, the
reschedule checks and the booking commit all call it. Later features add a step to
the working-hours chain or a filter to the list; they do not add a second code path.

Availability is advisory. The booking transaction locks the practitioner
(`for update`), then `commit.ts` loads fresh data, runs `offerableSlots` and requires
the requested start to be one of the results (this also locks the candidate rooms,
selects the free one and checks the booked length is one the service offers). The
appointment and its reservations are inserted together. PostgreSQL partial GiST
exclusion constraints independently prohibit overlap for both practitioners and
physical resources while reservation state is `held` or `confirmed`, so two
simultaneous bookings of the last slot give one success.

A person's hours for one date come from a chain of small steps in
`working-hours.ts`, always in this order: the schedule's weekly pattern (the
service's own schedule if it names one, else the person's default), the date's
override, public holiday (worked out from `date-holidays`, only the owner's opt-outs
are stored), out of office, blocked time, and last the service's restriction schedule.
Travel is not a step: it chooses the timezone a date is read in. Slot starts are laid
out on the hours before holidays, time away and blocks are cut out, so a block in the
middle of the day never moves the grid. `explain.ts` replays the same steps and
filters for one person and date, so "Why no slot?" cannot disagree with what a
customer sees.

Buffers widen the span that must be free around a visit; the stored reservation
carries its own buffers, so a later visit cannot start inside them. The visit and both
buffers must fit inside a working range. Changing a service's timing never moves
existing bookings.

Appointment instants are `timestamptz`; locations and availability rules retain
IANA timezone names. Recurring rules are weekday plus local wall-clock time and
zone. The engine turns wall-clock times into instants with `@date-fns/tz`; the
fixtures include the Europe/London change (`offerable-slots.test.ts`). API slots are
emitted as offset-aware ISO timestamps.

Booking POSTs require an `Idempotency-Key`. A unique
`(tenant_id, route, key)` row stores a canonical request hash and the successful
response. Reusing the key and body replays the response; reusing the key with a
different body returns `idempotency_conflict`. Appointment changes use an
integer version and reject stale writes with `version_conflict`. A GiST conflict
is normalized to `409 slot_unavailable`.

Manage links contain 256-bit random bearer tokens; only SHA-256 hashes are
stored. Token endpoints return appointment logistics, not customer contact data.
They support confirm, cancel, and reschedule. Status mutations write an audit
event and transactional outbox event in the same commit.

## APIs and preview behavior

- `GET /api/public/availability` returns `{ data: { slots } }`.
- `POST /api/public/appointments` returns HTTP 201 with appointment ID, manage
  token, status, start, and end.
- `GET|PATCH /api/public/appointments/[token]` powers customer self-service.
- `PATCH /api/appointments/[id]/status` requires a validated Better Auth
  session plus an authorized membership.
- Errors use `{ error: { code, message, fieldErrors? } }`, avoid identifiers and
  database details, and are never cached.

With no `DATABASE_URL`, development uses the in-memory demo repository. In
production this is disabled unless `KALENDR_PREVIEW_MODE=true`; never set that flag
on a real deployment. A configured database that becomes unavailable
does not silently fall back to demo data.

## Website connection

Offer businesses, in order:

1. A normal hosted booking link, which works on every website.
2. A responsive iframe for sites that own their markup.
3. `/kalendr-widget.js?v=3`, a tiny loader that opens the same SaaS-origin booking
   page in an iframe modal.

The loader carries no customer data. It validates `postMessage` origin, window,
protocol version, nonce, message schema, and opaque appointment reference; it
never uses `*` as a target origin. Staff login is never embedded. The booking
route defaults to `frame-ancestors 'self'`; deployments add exact business website origins
with `KALENDR_BOOKING_FRAME_ANCESTORS` (every business) and the sites each business
saved in `tenant_embed_origins` (feature 13). Custom hosts require CNAME/TXT ownership
proof, active TLS, a unique normalized hostname, and an active `tenant_domains` row
before routing; `src/proxy.ts` resolves them (see below).

## Calendar sync (feature 16)

Staff connect their own Google, Outlook or Apple calendars (migration `0031_calendar_sync`). Tables, all with `tenant_id`, composite keys and forced row-level security:

| Table | Holds |
| --- | --- |
| `calendar_connections` | One linked account per staff member (membership). The login is sealed (purpose `calendar.credentials`) with a `key_version`, and re-encrypted by the storage job. Status `pending`, `active`, `needs_reconnect` or `disconnecting`. |
| `calendar_selections` | One calendar of an account: blocks availability yes/no, writes here yes/no (one per person), the sync token, the watch channel and its expiry. |
| `external_busy` | Start, end and event id of busy time, per staff member. No titles. Unique per calendar and event id. |
| `appointment_event_links` | The event Kalendr wrote for an appointment: event id, etag, the fingerprint and times it pushed. |
| `calendar_conflicts` | "Needs a person": a linked event moved or deleted outside. One open item per appointment and calendar. |
| `calendar_webhook_events`, `calendar_feed_tokens`, `calendar_business_settings` | Webhook dedupe; the private `.ics` feed token (hash only); the business's event-text setting. |

A staff member and a practitioner are joined through `practitioners.auth_user_id = memberships.user_id`; staff with no practitioner row simply have no bookable time to protect. The availability query and the booking commit check (`src/server/appointment-repository.ts`) subtract `external_busy` through `externalBusyClash` in `src/server/external-busy.ts`, ignoring calendars not ticked, connections that need reconnecting, and events Kalendr wrote itself. Providers are reached only by the worker (`src/worker/calendar/`) and by the OAuth callback's code exchange. Adapters live in `src/server/calendars/`; `CALENDAR_PROVIDER_MODE=fake` swaps them for in-memory ones.

## Jobs, providers, and integrations

The durable outbox is the queue. A separate worker claims due rows with
`FOR UPDATE SKIP LOCKED`, uses a lease, bounded exponential retry, and a dead
letter state. `LISTEN/NOTIFY` may wake workers but never replaces polling.
Handlers are at-least-once and must use semantic dedupe keys. A reminder worker
re-reads appointment status/version immediately before sending. Logs and
messages must not contain booking form answers, reason-for-visit, or clinical detail.

What is built (feature 1): `src/worker/run.ts` (`pnpm worker`, image command
`node dist/worker.mjs`). It connects as its own role, `kalendr_worker`, which has
no BYPASSRLS.

The claim works like this:

- Migration `0015_production_worker` adds the definer function
  `kalendr_claim_outbox(worker_id, batch_size)`. It takes due rows with
  `FOR UPDATE SKIP LOCKED`, gives each a 60-second lease and a unique token, and
  returns only `(tenant_id, id)`.
- Each row is then handled in its own transaction under `app.tenant_id`, after
  the worker checks it still holds the lease.

Handlers live in `src/worker/handlers/` and have the signature
`(tenantDb, event) => delivered | retry | dead`. They drop an event whose version
is older than the appointment's.

A failure is retried at 5 s, 10 s, 20 s, … (capped at an hour). The 8th failure
goes to dead letter.

`KALENDR_WORKER_MODE` picks where messages go:

- `local_capture` (the default, and the only mode tests use) writes a
  `notifications` row and sends nothing.
- `production` hands the message to `ProviderAdapter`s in `src/worker/delivery.ts`.
  There are none yet, so messages dead-letter as `provider_not_configured`.

pg-boss 12 runs the repeating jobs (reminder sweep, hold expiry, calendar
renewal, retention, dead-letter report) from its own `kalendr_jobs` schema.
Each job finds its businesses through `kalendr_worker_tenants` (ids only).

Each worker upserts a row in `worker_heartbeats` and logs queue counts every
30 seconds. On SIGTERM it stops claiming, finishes its batch and hands back the
leases it did not start.

Staff with `messages.retry` see failed and dead-lettered messages on the
Messages screen and can put one back in the queue. That is audited as
`message.retry`.

Details are in `docs/WORKER.md`.

Calendar rollout is staged:

- Generate RFC 5545/5546 ICS with stable UID, incrementing `SEQUENCE`, UTC
  DTSTART/DTEND, and cancellation using the same UID.
- Google Calendar uses delegated OAuth, encrypted refresh tokens,
  deterministic event IDs, incremental sync tokens, renewable push channels,
  and periodic reconciliation because notifications are not guaranteed.
- Microsoft Graph uses `transactionId`, `getSchedule`, delta links, validated
  `clientState`, renewable subscriptions, and periodic reconciliation.
- Kalendr remains authoritative. External busy blocks affect availability;
  external edits do not silently reschedule a Kalendr appointment.

Optional deposits use Stripe Checkout/PaymentIntents with an expiring Kalendr hold.
Confirm payment only from a signature-verified webhook, dedupe provider event
IDs, and retrieve current provider state when delivery order is uncertain. A
late successful payment after hold expiry must be refunded rather than
overbooking. For business-as-merchant SaaS, evaluate Connect direct charges; the
commercial and liability model is a business/legal decision.

## Deployment and operations

The lowest-complexity production topology is one immutable standalone Next.js
image with `web` and `worker` commands, a reverse proxy/CDN/WAF, and managed
PostgreSQL 18.6 with point-in-time recovery in a region suitable for the
businesses. Run expand/contract migrations before the matching web and worker SHA.
Do not use a free database tier that pauses or lacks reliable restore/PITR for
production.

Required runtime environment:

- `DATABASE_URL`, optionally `DATABASE_POOL_MAX`
- `BETTER_AUTH_SECRET` (high-entropy, at least 32 bytes), `BETTER_AUTH_URL`
- `BETTER_AUTH_TRUSTED_ORIGINS`; optional explicitly reviewed signup and
  verification flags
- `NEXT_PUBLIC_APP_URL`, `DEPLOYMENT_VERSION`
- `KALENDR_BOOKING_FRAME_ANCESTORS` as comma-separated exact HTTPS origins
- `KALENDR_RECORDS_KEY` (key version 0, until retired everywhere),
  `KALENDR_KEY_PROVIDER=kms` with `KMS_KEY_ID` and `KMS_REGION`,
  `KALENDR_FILE_STORE=s3` with the `S3_*` variables, and `CLAMAV_HOST`
  (protected storage, feature 10: per-business envelope keys in
  `tenant_data_keys`, files in a private versioned bucket, ClamAV before a file
  can be opened; see `docs/SECURITY.md` and `docs/BACKUP_AND_RESTORE.md`)
- provider, calendar, payment, and observability secrets only when those
  adapters are enabled

Local PostgreSQL:

```sh
POSTGRES_PASSWORD="choose-a-local-only-password" docker compose up -d postgres
DATABASE_URL="postgresql://kalendr:<same-password>@127.0.0.1:5432/kalendr" pnpm db:migrate
```

Production provisioning must grant the runtime login only required table and
sequence privileges plus EXECUTE on `kalendr_resolve_tenant`,
`kalendr_resolve_manage_token`, and `kalendr_resolve_staff_appointment`. Keep those
functions owned by the privileged migration role. Do not make the web login a
table owner.

Use OpenTelemetry traces and metrics for HTTP, database transactions, booking
conflicts, queue age, retries, provider calls, calendar sync age, subscription
expiry, payment reconciliation, slow queries, pool saturation, TLS state, and
backup restores. JavaScript OpenTelemetry logs are not yet stable, so emit
structured JSON logs separately. Never use customer, appointment, or tenant IDs
as metric labels.

What is built (feature 35): `src/server/env.ts` checks every variable at start-up
and production stops with a message naming each missing one; `src/server/logger.ts`
writes pino JSON lines with request id, tenant and route, and redacts personal data
by key and by pattern; `src/instrumentation.ts` turns on Sentry (scrubbed by
`src/lib/sentry-scrub.ts`) and OpenTelemetry (`@vercel/otel`) only when their
variables are set; `/api/health` (liveness, no database) and `/api/ready`
(database plus migration version) answer the load balancer. Migration
`0014_observability` adds `outbox_events.trace_parent`, so a message the worker sends
joins the trace of the request that queued it, and the security-definer
`kalendr_schema_version()` that `/api/ready` reads. One `Dockerfile` builds the
image for web (`node server.js`), worker (`node dist/worker.mjs`) and the release
step (`node dist/migrate.mjs`). CI is `.github/workflows/ci.yml`; Playwright
journeys with an axe scan live in `e2e/`. Day-to-day running is in
`docs/OPERATIONS.md`.

Email (feature 2): the worker's email adapter (`src/worker/email-adapter.ts`) renders
React Email templates (`src/emails/`) and sends through a `MessageProvider`
(`src/server/messaging/`, Resend in production) with the notification's semantic key as
the idempotency key. Booking emails carry an `.ics` file and the manage link, whose token
is now kept sealed on the booking. Migration `0016_email_delivery` adds
`appointments.manage_token_ciphertext`, `message_suppressions`,
`message_delivery_events` (both with forced row-level security) and the
security-definer `kalendr_resolve_email_notification()` used by the svix-verified
`/api/webhooks/resend`. Account emails (`auth-email.ts`, `patient-auth.ts`) use the
same provider and templates. Details are in `docs/WORKER.md`.

Minimum release gates are cross-tenant tests using the real non-owner role,
100-way same-slot concurrency with exactly one success, DST gap/fold fixtures,
duplicate/out-of-order webhook fixtures, blocked-third-party-cookie iframe
tests, CSP/origin tests, and a restore drill.

## Official references

- [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting) and
  [deployment](https://nextjs.org/docs/app/getting-started/deploying)
- [Better Auth Next.js integration](https://better-auth.com/docs/integrations/next)
  and [Drizzle adapter](https://better-auth.com/docs/adapters/drizzle)
- [PostgreSQL row security](https://www.postgresql.org/docs/18/ddl-rowsecurity.html),
  [range/exclusion constraints](https://www.postgresql.org/docs/18/rangetypes.html),
  [date/time storage](https://www.postgresql.org/docs/18/datatype-datetime.html),
  and [`SKIP LOCKED`](https://www.postgresql.org/docs/18/sql-select.html)
- [MDN `frame-ancestors`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)
  and [`postMessage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
- [RFC 5545 iCalendar](https://datatracker.ietf.org/doc/html/rfc5545) and
  [RFC 5546 iTIP](https://datatracker.ietf.org/doc/html/rfc5546)
- [Google event creation](https://developers.google.com/workspace/calendar/api/guides/create-events),
  [incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync),
  and [push notifications](https://developers.google.com/workspace/calendar/api/guides/push)
- [Microsoft Graph create event](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0),
  [`getSchedule`](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0),
  [event delta](https://learn.microsoft.com/en-us/graph/delta-query-events), and
  [webhook delivery](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks)
- [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests),
  [webhooks](https://docs.stripe.com/webhooks), and
  [Connect direct charges](https://docs.stripe.com/connect/direct-charges)
- [Cloudflare for SaaS custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/)
- [OpenTelemetry JavaScript status](https://opentelemetry.io/docs/languages/js/)
  and [Collector](https://opentelemetry.io/docs/collector/)

## Explicit non-goals and caveat

This foundation is an appointment operations system for any business. For
healthcare and dental businesses it can hold visit documents, but it is not an
EHR/EMR, diagnostic tool, telemedicine service, or emergency channel. Its controls do not
by themselves establish compliance with HIPAA, India's DPDP Act, ABDM policies,
or another jurisdiction. Production use requires data-flow/legal review,
retention and deletion policy, incident response, vendor due diligence, and
signed BAAs/data-processing agreements where applicable.

## Scheduling engine additions (features 38 to 40)

- **Limits** (`src/server/slot-engine/limits*.ts`): one more filter in the slot engine. Periods are local dates in the business's timezone, computed by `periodBounds`; the commit takes ordered advisory locks per covering limit and recounts inside the serializable booking transaction.
- **Holds** (`src/server/slot-holds.ts`): a `slot_holds` row is busy time for everyone but its owner until `expires_at`; the booking commit consumes the owner's hold. The engine ignores expired rows, so the `hold-expiry` job only tidies.
- **Intake** (`src/server/booking-intake.ts`, `email-check.ts`): contact mode, guests and the email check run inside the booking transaction. The code email and guest messages are sent by the worker from the outbox; nothing here calls a provider.

## Customer sign-in upgrade (feature 8)

`patient-auth.ts` issues and verifies codes (growing delay, remember-this-device sessions); `patient-delivery.ts` hands the sealed code to the worker (`worker/patient-code-delivery.ts`: WhatsApp, text, email); `patient-devices.ts` lists and ends sessions; `patient-step-up.ts` is the manage-link guard (code, grant, paid and portal-session rules from `lib/patient-sign-in-rules.ts`); `booking-contact.ts` changes the contact on a booking and tells the other channel; `manage-token.ts` rotates a link on reschedule. Migration `0048_customer_sign_in`.

## Smart waitlist (feature 21)

`waitlist-offers.ts` (worker-safe core: matching, order, hold, cascade, quiet hours, sweep), `waitlist-hook.ts` (the one-line hooks `appointment-repository.ts` and `staff-operations.ts` call, inside a savepoint: an ordinary error rolls the savepoint back and the time simply goes public, but a serialization failure (40001, 40P01) is rethrown so the whole change is retried; `applyPatientAction` is now a retry wrapper, three tries, around `applyPatientActionOnce`), `waitlist-accept.ts` (public offer link: read, accept, decline, cancel the later booking), `waitlist-join.ts` (booking-page sign-up), `waitlist-staff.ts` (trail, order rule, per-service switch, offer by hand, withdraw). Pure rules (hold time, two-hour rule, order, time-of-day boundaries) are in `src/lib/waitlist.ts`.

- **Hold.** `resource_reservations.appointment_id` is not null, so a held reservation cannot exist before a booking. A live offer keeps its time in `slot_holds` (feature 39), purpose `waitlist`, which the slot engine already reads as busy for everyone. The hold gets its own random token that nobody sees, so the public hold-release route can never let it go.
- **Never a gap.** The first offer and hold are written in the freeing transaction through the same engine check as a booking (`assertSlotOfferable`, mode `existing`: notice and the booking window do not apply, hours, busy time, rooms and limits do). The cascade carries the same hold row to the next person in one transaction.
- **Accept.** The public link locks the offer row, requires `sent` and inside its answer time, books through the normal pieces (`loadBookingConfiguration`, `assertSlotOfferable` ignoring only the offer's own hold, `assertCustomerCap`, `insertReservations`, `recordMutation` for the usual `appointment.created` event and workflow planning), marks the entry `fulfilled`, and runs serializable with retry. A partial unique index allows one live offer per time; a second tap returns the same booking without a new link.
- **Tables.** `slot_offers` (forced row-level security, composite foreign keys to the entry, service, place and person; token hash, sealed token, hold id, chain id and position, status `scheduled`, `sent`, `accepted`, `declined`, `expired` or `withdrawn`), `waitlist_settings` (order rule) and `waitlist_service_switches` (automatic offers per service, default on). Migration `0049_waitlist_offers`; it also adds `kalendr_resolve_slot_offer(hash)` (ids only), a `waitlist_sweep` job to `kalendr_worker_tenants`, and a trigger that lets go of a held time when an entry is deleted (an erasure).
- **Entry status.** An offer sets the entry `offered`; an expiry, decline or staff release sets it back to `active` and excludes it from that time. `fulfilled` is set on accept. Staff can still set `offered` by hand from the waitlist menu; that has no offer behind it.


## Repeating appointments (feature 17)

`src/lib/series-rule.ts` (pure: the rule, `rrule` expansion, the summary sentence), `src/server/series.ts` (preview, save, series view, shared helpers), `src/server/series-change.ts` ("this and following" and "all": change and cancel), `src/server/series-contracts.ts` (request bodies). Routes: `POST /api/staff/series/preview`, `POST /api/staff/series` (save, `Idempotency-Key`), and `GET`, `POST` (preview a change) and `PATCH` (change or cancel) on `/api/staff/series/[id]`.

- **Tables.** `appointment_series` (forced row-level security; composite foreign keys to the customer, service, person and place; the rule as RFC 5545 text and as the structured form the screen edits; start date, clock time, length; exactly one of `until_on` or `occurrence_count`, at most 52; status `active`, `ended` or `cancelled`; a version; `continued_from_id` to the series it took over from) and `appointments.series_id` and `series_index` (both set or both empty, one visit per place in a series). Migration `0050_repeating_appointments`. The key from a visit to its series is checked at commit, not at once, because a brand-new customer only exists after the first visit is booked.
- **Dates.** The rule is expanded as calendar dates ("every Tuesday") and each date plus the clock time is turned into an instant with `localInstant` in the place's own time zone, so 10:00 stays 10:00 across a clock change. The caps are 52 visits and 12 months from the first day.
- **One transaction, no shortcut.** `insertStaffAppointment` (lifted out of the desk booking in `appointment-repository.ts`; the desk booking calls it too) books one visit: the same `assertSlotOfferable` check, booking limits, customer cap, reservations, audit row and outbox event. The series books its visits one after the other in date order inside one serializable transaction (retried on a serialization failure). Any visit that fails rolls the whole thing back and the route answers 409 with the list as it is now, the failed visit marked as a clash.
- **Preview.** Read only. One engine load for the whole range says which visits are offered; the reason for a clash is the "why no slot" explanation for that day (`describeReason` in `explain.ts`), and the same person's other free times that day are offered. A preview checks each visit against what is booked now, not against the other visits, so a limit the series would use up itself only shows at save, where it is marked on the failing visit.
- **Change and cancel.** Only booked or requested visits still ahead are touched; completed, checked-in, no-show and cancelled visits never are. "This and following" ends the old series on the day of the last visit it keeps and starts a new one (`continued_from_id`), cancelling the open visits quietly and booking the new list through the engine. Previewing a change releases the visits it would replace inside a transaction that is rolled back.
- **Messages.** A series sends one `series.confirmation` event (booked, changed or cancelled) listing every date, carried on the first visit's appointment. Series visits are marked in two places so the usual "booked" message is not sent for each: the worker's appointment message handler (`appointment.created`, and cancels marked `seriesBatch`) and the workflow planner (`PlanAppointment.inSeries`, the `booked` trigger). Reminders per visit, the reminder sweep and calendar writes are unchanged.
- **One visit on its own.** Moving or cancelling a single visit (staff, or the customer from their manage link) only updates that appointment, so it stays in its series. Whole-series changes are staff only (`series.manage`).

## Platform admin console (feature 15)

Migration `0048_platform_admin (and 0049_subscription_billing)` adds `platform_admins`, `impersonation_sessions`, `platform_audit_events`, `feature_rollouts` and `tenants.paused_at`, and the definer functions `admin_whoami`, `admin_list_tenants`, `admin_tenant_health`, `admin_find_notification`, `admin_find_outbox`, `admin_worker_health`, `admin_retry_dead_letter`, `admin_abuse_overview`, `admin_signups_by_day`, `admin_set_feature_rollout`, `admin_set_tenant_paused`, `admin_start/resolve/end_impersonation`, `admin_record_impersonation_view`, `admin_record_action`, `admin_tenant_owner`, `admin_list_platform_admins`, `admin_set_platform_admin`, `admin_list_audit` and `kalendr_rollout_enabled`. Application code: `src/server/admin-context.ts` (who is asking), `src/server/admin/*` (one module per area, zod-parsing every row into `src/lib/admin-contracts.ts`), `src/app/api/admin/*` (routes), `src/server/staff-impersonation.ts` (the staff context for "View as this business", called from `getStaffContext`), `src/server/feature-rollout.ts`, `src/server/tenant-pause.ts`, and the worker handler `verification-resend`. Details: `docs/platform-admin.md`.

## Plans and subscription billing (feature 14)

Tables (migration 0049): `plans` (global, readable by all), `tenant_subscriptions` (one row per business: plan, status, provider ids, trial and period dates, pending plan, `past_due_since`, overage mode, GSTIN, `usage_alerts_sent`, `version`), `billing_events` (provider webhook events, insert-only, deduped by provider and event id), `usage_counters` (per month and metric), `platform_invoices` (Kalendr's tax invoices, immutable, gapless numbers from `platform_invoice_counter`). All except `plans` have forced row-level security on `app.tenant_id`. Cross-business lookups go through definer functions that return ids only. Pure rules: `src/lib/entitlements.ts`, `src/lib/billing-rules.ts`. Server: `src/server/entitlements.ts`, `src/server/billing/*`. Worker: `src/worker/plan-gate.ts`, `billing-jobs.ts`, `handlers/billing.ts`. See `docs/subscription-billing.md`.

## Approval, cancel policy and bookings list (features 41 to 43)

New tables: `cancel_note_presets`, `saved_views`, `appointment_host_no_shows` (each with `tenant_id`, a composite unique `(tenant_id, id)`, forced row-level security and the `tenant_isolation` policy). New columns on `services` (approval rule, notice hours, hold, hidden location, cancel and reschedule switches and cut-offs, same person, request days) and `appointments` (decline and cancel reasons, sealed notes, who cancelled, the request-to-move time, the booking it replaces, the customer's offered times, the no-show mark). New statuses `declined`, `expired`, `reschedule_requested`. Every state change to one booking runs through `withLockedStaffAppointment` (`src/server/appointment-tx.ts`): row lock, version check, serializable retry; the change itself is a small function (`approval.ts`, `cancel-actions.ts`, `visit-actions.ts`) that the single-booking route and the bulk route share. Details and known limits: `docs/scheduling-approval-and-policy.md`.

## Public API and webhooks (feature 34)

Tables `api_keys`, `webhook_endpoints`, `webhook_deliveries` (migration 0042, forced RLS) and the definer function `kalendr_resolve_api_key`. `src/server/openapi-operations.ts` is the single source for the OpenAPI document, the `/developers` reference page and a test that fails if a route under `src/app/api/v1` is missing from the spec or the reverse. v1 has its own schemas (`api-v1-contracts.ts`) and never exposes internal names. Writes map to the staff booking input and call `createStaffAppointment`, `mutateStaffAppointment` and `updateAppointmentStatus` with an API-key actor; list endpoints use cursor paging (`api-v1.ts`). Settings > Developers manages keys and webhook addresses through `/api/staff/api-keys` and `/api/staff/webhooks`. Not in this release: plan-based limits (feature 14), MCP, CLI and embeds (later waves).

## Data import (feature 12)

Tables `import_jobs` and `import_rows` (migration 0043, forced RLS). Jobs move through uploaded, mapped, checking, checked, queued, running, done, with failed, undoing and undone off to the side. Code is in `src/server/imports/` (parse, map, validate, commit paths per kind), staff routes in `src/app/api/staff/imports/`, handlers in `src/worker/handlers/import.ts`, the wizard in `src/features/clinic/import-workspace.tsx` (opened from Customers and Settings > Import data). Validation reuses the app's own schemas; phones are stored as E.164 and compared with the same key `kalendr_normalize_phone()` uses.

## Embeds, staff notifications and AI access (features 52, 56, 54)

Migration `0063_embeds` adds `tracking_settings`, `booking_short_links` and after-booking columns on `services`; `0064_staff_notifications` adds `notification_preferences.email` and quiet-hours and digest columns on `memberships`. Both new tables have forced RLS. New definer functions: `kalendr_follow_booking_link` (web) and `kalendr_staff_digest_tenants` (worker only). Details: [embeds-and-conversion.md](embeds-and-conversion.md), [staff-notifications.md](staff-notifications.md), [developers/mcp.md](developers/mcp.md).
## Scheduling trust and wording (features 44, 45, 48, 50)

New tables, all with forced row-level security and the `tenant_isolation` policy: `blocklist_entries` (keyed hashes only), `booking_reports`, `special_links` (token hash only), `combined_links`, `service_templates`. New columns: `appointments.spam_state`, `special_link_id`, `group_ref`; `services.template_id`, `template_version` and the calendar wording columns; `tenants.reply_to_email`, `reply_to_verified_at`. New function `kalendr_resolve_special_link(text)` (security definer, ids only, runtime may execute). Details and limits: `docs/scheduling-trust-and-wording.md`.
## Branding and own web address (feature 13)

Migration `0055_branding_domains`: `tenants.brand`, new columns on `tenant_domains` (`last_checked_at`, `last_result`, `check_until`, `missing_since`), the table `tenant_embed_origins` (forced RLS, composite unique, shape check), and the definer functions `kalendr_domain_lookup`, `kalendr_embed_origins`, `kalendr_claim_hostname` and the worker-only `kalendr_domain_tenants`. `src/proxy.ts` (Node runtime in Next 16) resolves a host that is not Kalendr's own through `src/server/host-lookup.ts` (own small pool, bounded cache) and rewrites to that business's public pages, or answers 404. Pure rules: `src/lib/brand-theme.ts`, `src/lib/domain-rules.ts`, `src/lib/host-routing.ts`. Server: `src/server/brand.ts`, `src/server/domains/*`. Worker: `src/worker/domain-jobs.ts`. See `docs/branding-and-address.md`.

## Onboarding 2.0 (feature 11)

Migration `0056_onboarding_progress`: `onboarding_progress` (forced RLS), `appointments.is_test`, `patients.is_test`, `tenants.onboarding_started_at`, and the functions `kalendr_onboarding_tenants` (worker only), `kalendr_purge_test_rows` and `admin_onboarding_funnel`. Registration fills the account from a template (`src/lib/onboarding-templates.ts`, `src/server/onboarding/seed.ts`). Checklist rules are pure (`src/lib/onboarding-steps.ts`); the facts are read through a `Runner` (`src/server/onboarding/facts.ts`) so the web server and the worker share them. Staff routes under `/api/staff/onboarding`, the admin funnel at `/api/admin/onboarding`. Worker: `src/worker/onboarding-jobs.ts`. See `docs/onboarding.md`.

## Team routing (feature 20)

`src/lib/routing-rank.ts` (pure ordering), `src/server/routing.ts` (pool lock, who is free, the choice inside the booking transaction), `src/server/routing-admin.ts` (service settings, month share, moving a leave's bookings to the cover), routes under `src/app/api/staff/routing/`. Columns: `practitioner_services.priority` and `weight`, `services.assignment` and `prefer_returning_person`, and the index `appointments_routing_idx` for the 30-day count. Migration `0053_team_routing`; no new tables, so no new row-level-security policy. Details and limits: `docs/team-routing.md`.

## Group sessions and classes (feature 18)

`src/lib/classes-contracts.ts` (shared shapes and zod), `src/server/class-seats.ts` (seat count, the line, offers; written against `Runner` so the worker shares it), `src/server/classes.ts` (class types, sessions and timetables, roster actions, public timetable and enrolment, a customer's own link), routes under `src/app/api/staff/classes/` and `src/app/api/public/classes/` and `class-seats/`, worker handlers `class.notice` and `class.offer_expire` (`src/worker/handlers/class-notice.ts`), the email `src/emails/class-notice.tsx`.

- **Tables.** `class_sessions` and `class_enrolments` (forced row-level security; composite foreign keys; one place per customer per session), `services.kind` and `capacity`, and `resource_reservations.class_session_id` (exactly one of the appointment and the session owns a reservation). Migration `0054_group_classes`.
- **Seats.** A session's row is locked before its seats are counted, and the trigger `class_enrolments_within_capacity` refuses any write that would hold more seats than the session has. `kalendr_resolve_class_seat` is the one narrow lookup from a customer's token to a business. Details and limits: `docs/group-classes.md`.

## Money: invoices, packages, memberships and coupons (features 24 and 25)

- `payments` and `payment_refunds` stay the one ledger. A payment names a visit, or (for a sale with no visit, such as a package) a customer and a location; `invoice_id` links a visit-less sale to its invoice.
- Invoices (`invoices`, `invoice_lines`, `invoice_counters`, `credit_notes`, `credit_note_lines`, `invoice_documents`, `invoice_links`, `tax_settings`, `service_tax_rules`) are insert-only. Numbers come from `src/server/invoicing/number.ts`; tax from `src/lib/gst.ts`; one issuing function (`src/server/invoicing/issue-core.ts`) is shared by the desk, package sales and membership renewals.
- Credits are a ledger (`customer_credits`), never a counter. Offers (`packages`, `customer_packages`, `membership_plans`, `customer_memberships`, `membership_events`, `coupons`, `coupon_redemptions`, `appointment_discounts`) are applied to a booking by `src/server/offers/booking-offers.ts`, called from the booking transaction (public and staff) and released when a booking is cancelled or its hold expires.
- See [invoicing-and-gst.md](invoicing-and-gst.md) and [packages-and-coupons.md](packages-and-coupons.md).

## Booking assistant (feature 30)

Migration `0070_ai_assistant` adds `assistant_settings`, `assistant_conversations`, `assistant_messages` and `assistant_usage` (all forced RLS; message bodies, proposals, handoff summaries and the phone a code was sent to are sealed with the business's data key) and the `assistant` value on `booking_source`. No new SQL function. The model runs in the web request for the website chat and in the worker for WhatsApp (`assistant.inbound`). Details: [booking-assistant.md](booking-assistant.md).
## Routing forms (feature 46)

Migration `0073_routing_forms` adds `routing_forms`, `routing_form_versions`, `routing_responses` and `wrong_assignment_reports` (forced RLS; answers and notes sealed with the business's data key; the response token is stored only as a hash) and widens `campaigns_rule_ck` for the `routing_abandoned` rule. No new SQL function. A routed booking carries the response token through availability, the hold and the booking commit; `chooseAssignee` takes a server-side candidate set and weight multipliers. Details and limits: [routing-forms.md](routing-forms.md).

## Enterprise and teams (feature 53)

- New tables (migration `0067_enterprise`, forced row-level security on each): `teams`, `team_members`, `custom_roles`, `verified_domains`, `sso_connections`, `scim_tokens`, `attribute_definitions`, `practitioner_attributes`; `memberships` gains `custom_role_id`, `scim_external_id` and `break_glass`; `tenants.defaults`. The trigger `memberships_keep_one_owner` keeps one active owner per business.
- Cross-business lookups are narrow definer functions returning ids only: `kalendr_resolve_sso_domain`, `kalendr_resolve_sso_connection`, `kalendr_sso_required_for_user`, `kalendr_resolve_scim_token`; the worker lists businesses with `kalendr_email_domain_tenants`.
- Company sign-in: provider reply -> checked by `src/server/enterprise/saml.ts` or `oidc.ts` -> one-time ticket in `auth_verifications` -> Better Auth endpoint `/api/auth/sso/complete` makes the session. Directory sync is `src/server/scim/`. Details and limits: `docs/enterprise-and-teams.md`.
## Customer profiles and campaigns (features 27 and 28)

Customer data lives on `patients` plus `customer_tags`, `customer_tag_links`, `customer_notes`, `customer_segments`, `customer_field_definitions`, `customer_field_values` and `customer_merges` (migration 0068); a merged profile stays as a row with `merged_into_id` set and its contact details sealed in the merge snapshot. Campaigns live in `campaigns`, `campaign_sends` and `marketing_preferences` (migration 0069). The audience rules sit in one file (`src/server/campaigns/audience.ts`) that the web app, the fan-out and the send all read. All sending goes through the outbox and the existing adapters; see [customer-profiles.md](customer-profiles.md), [campaigns.md](campaigns.md) and [WORKER.md](WORKER.md).

## Branch-limited staff access

Migration `0080_membership_locations` adds `membership_locations` (forced RLS; no rows means every location) and widens the definer function `kalendr_resolve_staff_access` with a `location_ids text[]` column. `getStaffContext` turns it into `StaffContext.locationIds` and the server scopes through `src/server/location-scope.ts`. Details, the customer rule and what is not scoped yet: [branch-limited-access.md](branch-limited-access.md).
