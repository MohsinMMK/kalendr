# Features 1–10: Messages that arrive, and trust

Read `STANDARDS.md` first. Every feature below follows it; the sections here only add what is specific to the feature.

Each feature has six parts: **Why it matters**, **Use** (libraries and services), **Where** (files and tables), **How** (build steps in order), **Done when** (the test that proves it), and **Needs** (what must exist first).

---

## A. Messages that arrive

### 1. Production worker and scheduler

**Size:** M

**Why it matters.** Every message, reminder, payment follow-up and calendar update in this plan runs in the worker. Today it only records what it would have sent, and nothing runs on a timer. Without this, 20 of the other features cannot work.

**Use.** `pg-boss` 12.38.2 for timed and repeating jobs. The existing `outbox_events` table stays as the hand-off written inside each booking's transaction.

**Where.**

| Change | Path |
| --- | --- |
| Production mode, graceful stop | `src/worker/run.ts` |
| Claim loop (already written; keep the contract in `docs/WORKER.md`) | `src/worker/outbox-worker.ts`, `src/worker/policy.ts` |
| One handler per event type | new `src/worker/handlers/*.ts` |
| Repeating jobs | new `src/worker/schedules.ts` |
| Worker database role and claim function | new migration `drizzle/0014_*` |
| Heartbeat table | `worker_heartbeats` (not tenant-scoped: worker id, last seen, version) |
| Start script | `package.json`: add `worker` beside `worker:local` |

**How.**

1. Add a database role `kalendr_worker` with no `BYPASSRLS`. Add a `SECURITY DEFINER` function `kalendr_claim_outbox(worker_id, batch_size)` that locks due rows with `FOR UPDATE SKIP LOCKED`, sets the 60-second lease, and returns only `tenant_id` and `id`. The worker then opens `withTenant(tenant_id)` to read and process each event. This removes the `KALENDR_WORKER_TENANT_IDS` list.
2. Add `KALENDR_WORKER_MODE=production`. In this mode handlers call real providers through the adapters built in features 2–4. `local_capture` stays the default and is the only mode tests use.
3. Split handling into one file per event type with a shared signature: `(tenantDb, event) => Promise<"delivered" | "retry" | "dead">`. Each handler re-reads the appointment and its `version` first, and drops the event when the appointment has changed since.
4. Start `pg-boss` in the worker process, in its own schema. Register these repeating jobs: reminder sweep (every minute), slot-hold expiry (every minute), calendar channel renewal (hourly), retention (nightly), dead-letter report (hourly). Each job only **writes outbox rows or updates state**; the outbox handlers do the sending. That keeps one path for retries.
5. Write a heartbeat every 30 seconds. Stop cleanly on `SIGTERM`: stop claiming, finish the current batch, release leases.
6. Add a Messages screen filter for failed and dead-lettered items with a "Try again" button (permission `messages.retry`), which resets the event to pending and records an audit row.
7. Close the open Phase 5 boxes in `docs/END_TO_END_PLAN.md` by recording a database acceptance run.

**Done when.** Two workers run against one database and a booking's confirmation is processed exactly once. A handler made to fail is retried at 5 s, 10 s, 20 s and lands in dead letter after 8 attempts. Killing a worker mid-batch releases its rows within 60 seconds. A reminder for an appointment that was moved is dropped, not sent.

**Needs.** Nothing. Build this first.

---

### 2. Email delivery

**Size:** M

**Why it matters.** Today no customer receives a confirmation. Email is the cheapest channel, needs no regulatory approval, and unlocks owner registration in production (which is closed until verification email works).

**Use.** `resend` 6.38.0, `react-email` 6.11.16, `svix` 2.10.0.

**Where.**

| Change | Path |
| --- | --- |
| Provider contract shared by all channels | new `src/server/messaging/provider.ts` |
| Email adapter and a fake for tests | new `src/server/messaging/email-resend.ts`, `email-fake.ts` |
| Templates | new `src/emails/*.tsx` |
| Delivery webhook | new `src/app/api/webhooks/resend/route.ts` |
| Existing raw sends, moved onto the adapter | `src/server/auth-email.ts` |
| Worker handler | `src/worker/handlers/send-notification.ts` |
| Suppression list | new table `message_suppressions` (tenant, channel, destination hash, reason) |

**How.**

1. Define the contract every channel implements:
   ```ts
   export interface MessageProvider {
     channel: "email" | "sms" | "whatsapp";
     send(message: RenderedMessage): Promise<{ providerMessageId: string }>;
   }
   ```
   Errors are thrown as `TransientSendError` (retry) or `PermanentSendError` (dead letter, with a `failureCode`).
2. Write templates as React components with typed props: booking confirmed, request received, request approved, reminder, rescheduled, cancelled, moved by the business, review request, sign-in code, staff invite, password reset, email verification. Each takes the business name, logo, accent colour and its own words from the terminology system. Every template has a plain-text version.
3. Every appointment email carries the calendar file (`src/server/icalendar.ts` already builds it) and the manage link.
4. Send from the worker only. Use the notification's `semanticKey` as Resend's idempotency key so a retry cannot send twice.
5. Set `Reply-To` to the business's email, and the sender name to the business's name.
6. Webhook: verify with `svix`, look up the notification by `providerMessageId` through a narrow lookup function, and set `delivered` or `failed`. On a hard bounce or complaint, add the address to `message_suppressions`; the send handler checks this list first.
7. Add `pnpm email:dev` to preview templates locally.
8. Update the Messages screen to show real status, and remove the notice that nothing is delivered once a business has email working.

**Done when.** A booking on the local database produces a real email at a test address with a working calendar file and manage link. The webhook marks it delivered. A bounced address is suppressed and the next send to it is skipped with a clear reason in Messages. Owner registration works with `KALENDR_ALLOW_CLINIC_REGISTRATION=true`.

**Needs.** Feature 1. A Resend account and a verified sending domain.

---

### 3. WhatsApp delivery and inbox

**Size:** L

**Why it matters.** In India, WhatsApp is where customers read messages. Reminders with a one-tap Confirm button are the single most effective way to cut no-shows, and two-way replies let the front desk handle changes without phone calls.

**Use.** Meta WhatsApp Cloud API through `fetch`. `libphonenumber-js` 1.13.16.

**Where.**

| Change | Path |
| --- | --- |
| Adapter and fake | new `src/server/messaging/whatsapp-cloud.ts`, `whatsapp-fake.ts` |
| Webhook (verify and receive) | new `src/app/api/webhooks/whatsapp/route.ts` |
| Template registry | new table `message_templates` (channel, key, language, provider name, status, variables) |
| Conversations | new tables `message_threads` (customer, channel, last message at, window closes at, assigned to, unread count) and `messages` (direction, body encrypted, provider id, status, appointment id) |
| Inbox screen | `src/features/clinic/messages-workspace.tsx` gains an Inbox tab |
| Reply route | new `src/app/api/staff/threads/[id]/messages/route.ts` |
| Settings | new section in `src/features/clinic/settings-workspace.tsx` |

**How.**

1. **Start with one Kalendr-owned number** that sends for every business, with the business name in the message. Businesses that want their own number come later through Meta's Embedded Signup; design the tables with a nullable `tenant_whatsapp_accounts` reference so this is an addition, not a rewrite.
2. Submit these templates for approval: booking confirmed, reminder (with **Confirm** and **Reschedule** quick-reply buttons), rescheduled, cancelled, waitlist offer, review request, and an authentication template for sign-in codes. Store the approved names and languages in `message_templates`. Handle `message_template_status_update` so a rejected template is flagged in Settings.
3. Normalise every number to E.164 with `libphonenumber-js` using the business's country as the default. Refuse to send to a number that does not parse.
4. Send only when `patients.messagingConsentAt` is set. `src/lib/notification-routing.ts` already falls back to email without it; keep that rule.
5. Webhook `GET` answers the `hub.challenge` check against `WHATSAPP_VERIFY_TOKEN`. Webhook `POST` verifies the signature (confirm the header name in Meta's docs), dedupes on the message id, and writes an outbox row.
6. Worker handling of incoming events:
   - Status update: set the notification to delivered, read or failed.
   - Button tap **Confirm**: set `appointments.confirmationStatus = 'confirmed'` with a version check and an audit row.
   - Button tap **Reschedule**: reply with the manage link.
   - Free text: add to the thread, raise the unread count, and notify staff (feature 32).
   - The words STOP or UNSUBSCRIBE: clear messaging consent, record it (feature 7), and confirm once.
7. Inbox: threads on the left, conversation on the right, the customer's next appointment at the top. Staff can type a free-form reply only while the 24-hour window is open; after that the box offers approved templates only, and says why.
8. Record the cost category of every sent template (utility, marketing, authentication) for the usage meter in feature 14.

**Done when.** On Meta's test number: a booking sends a confirmation; a reminder shows two buttons; tapping Confirm marks the appointment confirmed on the staff schedule within seconds; a typed reply appears in the Inbox and staff can answer it; a customer who sends STOP gets no further WhatsApp messages and their next update goes by email.

**Needs.** Features 1 and 2. Meta Business verification, a number, and approved templates (allow one to two weeks; start this on day one).

---

### 4. SMS delivery (DLT)

**Size:** M

**Why it matters.** SMS reaches customers without WhatsApp or a smartphone, and is the fallback for sign-in codes. In India it will not deliver at all without DLT registration, so it must be built to those rules from the start.

**Use.** MSG91 Flow API through `fetch` for India; `twilio` 6.3.0 elsewhere.

**Where.**

| Change | Path |
| --- | --- |
| Adapters and fake | new `src/server/messaging/sms-msg91.ts`, `sms-twilio.ts`, `sms-fake.ts` |
| Provider choice | `src/server/messaging/index.ts` reads `SMS_PROVIDER` |
| Delivery webhooks | new `src/app/api/webhooks/msg91/route.ts`, `src/app/api/webhooks/twilio/route.ts` |
| Templates | `message_templates` rows with `channel = 'sms'` and the DLT template id |

**How.**

1. Each SMS template in `message_templates` stores the exact approved wording, the DLT template id and the variable order. The adapter sends variables only; it never builds free text, because the networks reject anything that differs from the approved wording.
2. Keep SMS short and transactional: confirmation, reminder, rescheduled, cancelled, sign-in code. Each ends with the short manage link.
3. Add a short-link route `/m/[code]` that redirects to the manage page, so links fit in one SMS segment. Codes are random, stored hashed, and expire with the manage token.
4. Count segments (GSM-7 versus Unicode) and record them on the notification for the usage meter in feature 14.
5. Set the fallback order in `src/lib/notification-routing.ts`: WhatsApp, then SMS, then email, driven by consent, the customer's preferred channel, and what the business has switched on. When WhatsApp reports failed, the worker queues the SMS version once.
6. Twilio webhook: verify `X-Twilio-Signature`. MSG91 webhook: verify with the shared secret set on the MSG91 dashboard, and restrict by the secret path token.

**Done when.** With MSG91 test credentials, a booking by a customer whose preferred channel is "phone" produces one SMS with the right DLT template id and variables. A WhatsApp failure produces exactly one SMS fallback. A Hindi template is counted as Unicode segments.

**Needs.** Features 1 and 2. DLT registration, an approved header and approved templates.

---

### 5. Message workflows

**Size:** L

**Why it matters.** Every business wants different timing: a dentist reminds at 24 hours and 2 hours; a salon sends a review request after the visit; a clinic chases a missing form. Making reminders data instead of code lets each owner set this up without a developer, and it is the base for campaigns (28) and onboarding emails (11).

**Use.** No new library. Scheduling runs on feature 1.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `workflows` (name, trigger, offset minutes, filters jsonb, active), `workflow_steps` (order, channel, template key, wait minutes), `scheduled_messages` (appointment, step, send at, status; **unique on tenant + appointment + step**) |
| Engine | new `src/server/workflows/engine.ts`, `triggers.ts`, `render.ts` |
| Worker | `src/worker/handlers/workflow-*.ts`, reminder sweep in `src/worker/schedules.ts` |
| Routes | new `src/app/api/staff/workflows/route.ts`, `[id]/route.ts`, `[id]/test/route.ts` |
| Screen | new Settings section "Reminders and follow-ups" |
| Presets | new `src/lib/workflow-presets.ts`, keyed by business type in `src/lib/business-types.ts` |

**How.**

1. Triggers: `booked`, `requested`, `rescheduled`, `cancelled`, `before_start` (offset), `after_end` (offset), `no_show`, `form_missing` (offset before start), `checked_in`.
2. When an appointment is created or changed, in the same transaction, the engine works out which workflows apply (by service, location, staff member, booking source) and inserts `scheduled_messages` rows with their send time. The unique index makes this safe to repeat.
3. **On reschedule or cancel, mark pending rows for that appointment as cancelled and insert fresh ones.** This is the rule that stops a reminder for a cancelled visit.
4. The reminder sweep (every minute) claims rows that are due, re-reads the appointment, skips anything that no longer applies (cancelled, already confirmed for a "please confirm" step, outside quiet hours), and writes a `notifications` row plus an outbox event.
5. Templates use named variables in braces, such as `{customer_first_name}`, `{service}`, `{staff_name}`, `{date}`, `{time}`, `{location}`, `{manage_link}`. Rendering refuses unknown variables at save time, not at send time. Dates and times are rendered in the location's timezone and the customer's language (feature 33).
6. Quiet hours per business (default 9 pm to 8 am local): a message due in quiet hours waits until they end, unless it is a confirmation the customer just asked for.
7. Give every new business a sensible preset from its type, switched on: confirmation at once, reminder at 24 hours, reminder at 2 hours, review request 2 hours after. Owners edit from there.
8. The screen shows each workflow as a sentence a person can read: "**24 hours before** the appointment, send **WhatsApp**: Reminder with Confirm button." A "Send me a test" button sends to the signed-in user only.
9. Fold the existing "moved by the business" and review-request sends into the engine so there is one path.

**Done when.** A booking 3 days out creates two reminder rows. Moving it replaces both. Cancelling it cancels both and nothing is sent. A reminder due at 2 am waits until 8 am. An owner changes the 24-hour reminder to 48 hours on the screen and the next booking uses it. Saving a template with `{unknown}` is refused with a clear message.

**Needs.** Features 1 and 2 (3 and 4 add channels).

---

## B. Trust and sign-in

### 6. Staff sign-in options and second factor

**Size:** L

**Why it matters.** Staff today can sign in only with a password. Owners expect "Continue with Google", front-desk staff forget passwords, and an account that can see customer records and take payments needs a second factor.

**Use.** `better-auth` 1.7.21 with `socialProviders` (Google, Microsoft), the `magicLink` and `twoFactor` plugins, and `@better-auth/passkey` 1.7.21.

**Where.**

| Change | Path |
| --- | --- |
| Auth config | `src/lib/auth.ts`, `src/lib/auth-client.ts` |
| Auth tables (two-factor, passkey) | `src/db/schema.ts` and a migration. Translate the plugin's schema into Drizzle by hand |
| Sign-in screen | `src/app/sign-in`, `src/features/clinic/staff-auth-controls.tsx` |
| Security settings | `src/features/clinic/profile-workspace.tsx`: second factor, passkeys, signed-in devices |
| Enforcement | `src/server/staff-context.ts` |
| Policy per business | `tenants.features` or a new `security_policy` jsonb |

**How.**

1. Read the current better-auth docs for each plugin first; plugin options change between versions.
2. **Social sign-in must never create access by itself.** Generic sign-up stays off. Allow a Google or Microsoft sign-in only when the verified email already belongs to a user with an active membership or a pending invite; otherwise show "Ask your manager to invite you." Link the provider to the existing user only when the provider says the email is verified.
3. Magic link: email a one-time link (through feature 2) valid for 10 minutes, single use, same device not required. Rate-limit by email and IP (feature 9).
4. Second factor: authenticator app codes with one-time backup codes shown once. Owners and admins **must** enrol; `getStaffContext` returns a `second_factor_required` error for those roles until they do, and the app sends them to the enrolment screen. Other roles follow the business's policy.
5. Passkeys: offer "Add a passkey" after sign-in. A passkey sign-in counts as two factors.
6. Devices: list active sessions with device, place and last used; allow "Sign out" per device and "Sign out everywhere". Changing a password or removing a second factor signs out other devices.
7. Step-up: these actions need a second-factor check within the last 10 minutes: changing roles and permissions, payment settings, API keys, data export, deleting a customer. Add a `requireRecentStepUp(context)` helper beside `requirePermission`.
8. Record every sign-in, failure, factor change and device removal in `audit_events`.
9. Email the user when a new device signs in or a factor changes.

**Done when.** An invited receptionist signs in with Google on first use. A stranger with a Google account is refused and no user row is created. An owner without a second factor is taken to enrolment before seeing any data. A passkey sign-in works on a phone. Removing a device ends its session at once. Opening payment settings after 10 minutes asks for a code.

**Needs.** Feature 2. Google and Microsoft OAuth apps.

---

### 7. Privacy centre (DPDP)

**Size:** L

**Why it matters.** India's data protection rules take full effect on 13 May 2027. Businesses will ask how Kalendr handles consent, export and deletion before they sign up, and clinics will not adopt a tool that cannot answer. This is also the base that marketing messages (28) legally depend on.

**Use.** `fflate` for the export zip (check the version).

**Where.**

| Change | Path |
| --- | --- |
| Tables | `consent_records` (**append-only**: customer, purpose, granted or withdrawn, wording version, source, time), `data_requests` (type: export, erasure or correction; status; due at; handled by), `retention_policies` (data kind, keep for days, action), `privacy_notices` (version, language, text) |
| Server | new `src/server/privacy/consent.ts`, `export.ts`, `erasure.ts`, `retention.ts` |
| Customer screens | `src/app/portal/privacy` |
| Staff screens | new Settings section "Privacy", and a "Privacy requests" list |
| Worker | nightly retention job; export builder |
| Runbook | new `docs/INCIDENT_RUNBOOK.md` |

**How.**

1. Purposes are separate and never bundled: appointment messages, marketing messages, reviews, records sharing. `patients.privacyAcceptedAt` and `messagingConsentAt` stay as fast lookups, and each change also writes a `consent_records` row with the exact wording version shown.
2. Show a plain-language notice at booking and at portal sign-in, in the customer's language, with a link to the full text. Withdrawing must be as easy as giving: one switch per purpose in the portal, and STOP on WhatsApp or SMS.
3. Export: a customer asks in the portal (after a sign-in code). The worker builds a zip of their profile, appointments, form answers, messages, payments and shared records as JSON and readable PDF, stores it encrypted, and emails a link that works once for 7 days.
4. Erasure: a customer asks; staff approve or refuse with a reason. Approval removes or anonymises personal fields, but keeps what law requires (invoices, and medical records for the retention period the business has set) and says so plainly to the customer. Never delete audit rows; replace the personal fields in them.
5. Every request gets a due date 90 days out and appears in the staff list with days remaining. Overdue requests alert the owner.
6. Retention: defaults per business type that the owner can change, for example sign-in codes 1 day, message bodies 1 year, logs 1 year, cancelled-booking details 2 years. The nightly job applies them and records counts in `audit_events`.
7. Children: when a customer is under 18, record the parent or guardian who consented. Do not send marketing for dependants.
8. Breach runbook: who decides, how to find affected tenants and customers from audit and access logs, the 72-hour reporting step, and message templates. Add an admin-console action (feature 15) that lists affected people for a given time window.
9. Add a per-business processing summary page (what is collected, why, who it is shared with: the providers in `LIBRARIES_AND_APIS.md`).
10. **Wording rule:** the product says "tools to help you meet your duties". It never says "compliant". A lawyer must review the notice text before launch.

**Done when.** A customer downloads their data from the portal. A customer withdraws marketing consent and is excluded from the next campaign while still getting appointment reminders. An approved erasure removes their name and phone everywhere except the retained invoice, and the audit trail shows who approved it. The retention job deletes expired sign-in codes and reports the count.

**Needs.** Features 1 and 2. A legal review of the notice wording.

---

### 8. Customer sign-in upgrade

**Size:** M

**Why it matters.** Customers sign in with a code, but the code reaches them only by email. Most customers in India gave a phone number, so today they cannot reach their own bookings. The private manage link also never expires, which is a risk if a message is forwarded.

**Use.** Features 3 and 4 for delivery. No new library.

**Where.**

| Change | Path |
| --- | --- |
| Code delivery and limits | `src/server/patient-auth.ts` |
| Routes | `src/app/api/portal/auth/request`, `verify` |
| Manage link | `src/server/appointment-repository.ts`, `src/app/manage/[token]` |
| Step-up | new `src/server/patient-step-up.ts` |

**How.**

1. Send sign-in codes by WhatsApp (authentication template with a copy-code button), falling back to SMS, then email. Remove the production error for phone sign-in.
2. Add limits per IP address and per device as well as per contact (feature 9). Add a short, growing delay after each wrong code.
3. Bot protection on the request-code form (feature 9).
4. Manage links: add `manage_token_expires_at`. A link works until 30 days after the appointment ends, then shows "Sign in to see this booking". Issue a fresh token when an appointment is rescheduled, and send it in the reschedule message; the old one stops working.
5. Step-up: viewing a booking with the link is allowed. **Cancelling, rescheduling, or changing contact details asks for a one-time code** sent to the contact on the booking, unless the customer is already signed in to the portal on that device. A paid booking always asks.
6. "Remember this device for 30 days" on the portal, with a list of devices and a sign-out button.
7. Tell the customer by their other channel when their contact details change.

**Done when.** A customer with only a phone number signs in with a WhatsApp code. The sixth code request in an hour from one IP is refused. A manage link from an appointment 31 days ago no longer opens it. Cancelling from a forwarded link asks for a code the forwarder does not have.

**Needs.** Features 3, 4 and 9.

---

### 9. Rate limits and bot protection

**Size:** M

**Why it matters.** The current limiter lives in one server's memory, so it resets on every deploy and does not work with two servers. Public booking, sign-in codes and registration are open to scripted abuse, which costs real money once messages are paid for.

**Use.** A PostgreSQL table by default. `@upstash/ratelimit` 2.2.0 only if the host already has Redis. Cloudflare Turnstile for bot checks.

**Where.**

| Change | Path |
| --- | --- |
| Limiter | new `src/server/rate-limit.ts`, replacing `src/server/registration-limit.ts` |
| Table | `rate_limit_buckets` (key hash, window start, count; not tenant-scoped; cleaned nightly) |
| Bot check | new `src/server/turnstile.ts`, new `src/components/turnstile-field.tsx` |
| Headers | `src/lib/security-headers.ts`, `src/proxy.ts` |
| Applied in | `src/server/http.ts` helper `enforceLimit(request, rule)` |

**How.**

1. One function: `enforceLimit(rule, keys)` runs a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count` and throws `ApiError` 429 with a `Retry-After` header. Keys are hashed, so no IP or phone number is stored in the clear.
2. Define rules in one file so they can be read at a glance:

   | Endpoint | Limit |
   | --- | --- |
   | Registration | 5 per 15 minutes per IP |
   | Staff sign-in | 10 per 15 minutes per IP and per email |
   | Customer code request | 5 per hour per contact, 20 per hour per IP |
   | Code verify | 5 per code, 30 per hour per IP |
   | Public availability | 120 per minute per IP |
   | Public booking | 10 per hour per IP, 5 per hour per contact |
   | Manage link actions | 20 per hour per token |
   | Public API (feature 34) | Per key, by plan |

3. Read the client IP from the header the host sets, behind a `TRUSTED_PROXY_HOPS` setting. Never trust a client-supplied forwarding header otherwise.
4. Turnstile on registration, customer code request, and public booking. Show it only when the request looks risky (second attempt, no prior session) so normal customers rarely see it. The server verifies the token; a missing or failed token returns a field error.
5. Add Turnstile's script and frame sources to the CSP with the nonce.
6. Finish the per-tenant CSP for embedded booking: `frame-ancestors` built from the business's saved origins (feature 13) instead of one deployment-wide list.
7. Add a honeypot field and a minimum fill time to the public booking form as a free first filter.
8. Count refused requests per rule in the metrics from feature 35.

**Done when.** The sixth registration attempt in 15 minutes is refused, and still refused after the server restarts. Two app servers share one count. A scripted run of 100 booking posts is stopped after 10. A real customer on a phone books without seeing a challenge.

**Needs.** Feature 35 is helpful but not required. A Cloudflare account for Turnstile keys.

---

### 10. Protected storage

**Size:** L

**Why it matters.** Records are encrypted with one key from an environment variable, files sit on one server's disk, and uploads are not scanned. The roadmap already says this is not ready for real customer data. Clinics cannot go live without it, and payments (23) and calendar sync (16) will store more secrets.

**Use.** `@aws-sdk/client-s3` 3.1167.0 (works with S3, Cloudflare R2, MinIO), `@aws-sdk/client-kms`, ClamAV.

**Where.**

| Change | Path |
| --- | --- |
| Storage adapter | new `src/server/file-store-s3.ts` implementing the existing `FileStore` in `src/server/file-store.ts` |
| Key provider | new `src/server/keys/provider.ts`, `kms.ts`, `local.ts` |
| Encryption | `src/server/record-crypto.ts` |
| Tables | `tenant_data_keys` (tenant, version, wrapped key, created, retired); add `key_version` to every table holding ciphertext; add `scan_status` to file tables |
| Scanner | new `src/server/scan/clamav.ts`, worker handler `scan-file.ts` |
| Local services | `compose.yaml`: add `minio` and `clamav` |

**How.**

1. **Envelope encryption.** Each business gets its own data key. The key is created by KMS, stored only in wrapped form in `tenant_data_keys`, and unwrapped in memory with a short cache. `sealBytes` and `openBytes` keep their signatures, look up the key by tenant and version, and write the version beside the ciphertext.
2. Migration path: the current key becomes version 0 and keeps opening old data. New writes use version 1. A background job re-encrypts old rows in batches and reports progress. Nothing is unreadable at any point.
3. Rotation: a yearly job (or an admin action) makes a new version for a tenant; old versions stay for reading until re-encryption finishes, then are retired.
4. S3 adapter: one bucket, keys shaped `tenant/{tenantId}/{kind}/{id}`. Files are encrypted by Kalendr before upload, so the bucket never holds readable content. Turn on bucket versioning and block all public access. Downloads keep going through the audited routes; never hand out a public link.
5. Virus scan: an upload is stored with `scan_status = 'pending'` and cannot be opened or shared. The worker streams it to ClamAV; clean files become available, infected ones are deleted and the uploader is told. The screen shows "Checking file…" in between. When no scanner is configured in production, uploads are refused rather than accepted unscanned.
6. Move staff photos and business images out of database columns into the file store, behind the existing media routes, with a backfill job.
7. Encrypt the new secrets added by other features (OAuth tokens, gateway keys, webhook secrets) through the same key provider.
8. Write `docs/BACKUP_AND_RESTORE.md`: database backups with point-in-time recovery, bucket versioning, and a restore drill. Run the drill once and record it in `docs/verification/`.

**Done when.** With MinIO and ClamAV running locally: an uploaded report is unreadable in the bucket, opens through the app, and is blocked while pending. The EICAR test file is rejected. Rotating a tenant's key leaves old and new records readable. Records created before the change still open. A restore drill is recorded.

**Needs.** Feature 1. An object storage bucket and a KMS key.
