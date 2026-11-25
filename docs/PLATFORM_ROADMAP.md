# Platform roadmap

> Kalendr now serves any appointment-led business. This roadmap was written for clinics and uses healthcare words (patients, doctors, visits). Records, the document check in the portal and Phase 5 apply only to businesses whose type is healthcare or dental, or that turn the records feature on. Every other business sees its own words on screen; tables keep their original clinic names.

Where Kalendr stands and what it takes to manage customers, providers and admins end to end. "Built" means it runs and has been tested. Everything else is a plan.

## How it runs

| Part | What it is | What you manage |
| --- | --- | --- |
| Web app | Next.js standalone server in the container image (`Dockerfile`, `node server.js`) | Hosting, `BETTER_AUTH_SECRET`, `NEXT_PUBLIC_APP_URL`, `KALENDR_RECORDS_KEY`. It stops at start-up and names any missing one |
| Database | PostgreSQL 18 with row-level security per business | Backups and restores, `DATABASE_URL`, the release step `node dist/migrate.mjs` on every release. See `docs/OPERATIONS.md` |
| Worker | `node dist/worker.mjs` from the same image (`pnpm worker`; `pnpm worker:local` in development). Sends what the outbox queues and runs the repeating jobs | Keeping two or more running as the `kalendr_worker` role (`WORKER_DATABASE_URL`), `KALENDR_WORKER_MODE=production`, provider keys once adapters exist. See `docs/WORKER.md` |
| Monitoring | JSON logs with personal data redacted, `/api/health`, `/api/ready`; Sentry and OpenTelemetry when their variables are set | A Sentry project and alerts. See `docs/OPERATIONS.md` |
| CI | `.github/workflows/ci.yml`: checks, knip, dependency audit, browser journeys on PostgreSQL 18, container build | Making the checks required on `main` (branch protection) |
| Preview | No `DATABASE_URL`: demo data held in the browser tab | Nothing. It never reaches the public booking pages |

Migration `drizzle/0004_cheerful_baron_zemo.sql` adds doctor profile fields and the "moved by the clinic" record. Migration `drizzle/0005_safe_scorpion.sql` adds patient accounts, sign-in codes, sessions, identity confirmations, visit records and record files. Apply both to any real database before deploying this version. Migration `drizzle/0014_observability.sql` adds `outbox_events.trace_parent` and the `kalendr_schema_version()` function that `/api/ready` reads; grant the runtime role EXECUTE on it (the release step does).

Migration `drizzle/0035_booking_limits.sql` (feature 38) adds `booking_limits` (one owner column per scope, each a composite foreign key, with a check that exactly the scope's column is set), `limit_teams` and `limit_team_members` (hand-picked pools until feature 53), and `services.max_active_per_customer`, `offer_reschedule_when_capped` and `first_slot_only`. Migration `drizzle/0036_booking_page.sql` (feature 39) adds `slot_holds` (a five-minute hold on a time, token hash only), the booking page columns on `services` (layouts, default layout, timezone lock, week start) and `tenants.default_clock` and `week_start`. Migration `drizzle/0037_booking_questions.sql` (feature 40) adds `email_checks` (hashes only), `form_definition_services.required_overrides`, `appointments.guest_emails_ciphertext` (sealed) and the contact, guest and email-check columns on `services`. Every new table has forced row-level security. They were numbered 0032 to 0034 on the branch and renumbered after the messaging, workflow and video migrations.

Migration `drizzle/0045_approval_rules.sql` (feature 41) adds `declined` and `expired` to `appointment_status`, the approval columns on `services`, `appointments.decline_reason_code` and `proposed_starts`, and extends `kalendr_worker_tenants` with the `request_expiry` job. Migration `drizzle/0046_cancel_policy.sql` (feature 42) adds `reschedule_requested`, the cancel policy columns on `services`, the reason, who and rebook columns on `appointments`, `cancel_note_presets` (forced row-level security) and the `reschedule_expiry` job. Migration `drizzle/0047_bookings_list.sql` (feature 43) adds `saved_views` and `appointment_host_no_shows` (forced row-level security), `appointments.customer_no_show_marked_at` and the list indexes. All three follow the trunk's 0042 to 0044; see `docs/scheduling-approval-and-policy.md`.

Migration `drizzle/0031_availability_schedules.sql` (feature 37) adds `availability_schedules`, `availability_overrides`, `holiday_settings`, `travel_periods` and `time_off` (all with row-level security), `availability_rules.schedule_id` (every person with hours gets one default schedule; a trigger files rules inserted without a schedule under the default) and an overlap constraint on a schedule's ranges, and `services.schedule_id` / `restriction_schedule_id`. `time_off` is shared with feature 20, which adds routing on top.

Migration `drizzle/0030_service_setup.sql` (feature 36) adds service timing, window, colour, visibility and link-name columns, `services.version`, the `service_durations` and `service_location_options` tables (with row-level security), and `appointments.location_kind` / `location_detail`. It gives every existing service one default length and in-person options for its branches, and a link name from its name. Numbered 0026 on a branch; the integrator renumbers on a clash.

Migration `drizzle/0015_production_worker.sql` adds:

- the `worker_heartbeats` table;
- three definer functions only the worker may call: `kalendr_claim_outbox`, `kalendr_worker_tenants` and `kalendr_outbox_health`;
- the `kalendr_jobs` schema for pg-boss.

Before the release step, create the `kalendr_worker` role (`NOBYPASSRLS NOSUPERUSER`, `docs/OPERATIONS.md`), then run the release step with `KALENDR_WORKER_ROLE`. The step grants the worker its tables, the functions and `kalendr_jobs`, and revokes the three functions from the runtime role.

Migration `drizzle/0039_privacy_centre.sql` (feature 7; the integrator may renumber it) adds the privacy tables `consent_records`, `privacy_notices`, `data_requests`, `data_exports` and `retention_policies`, guardian columns and `erased_at` on `patients`, the append-only trigger on consent, and four definer functions. Apply it before deploying, then run the release step again: it must revoke `kalendr_erase_consent_records`, `kalendr_scrub_audit_personal` and `kalendr_breach_affected` from the web app's role (the updated `scripts/migrate.mjs` does). The worker must be restarted to pick up the two new nightly jobs. See [privacy-centre.md](privacy-centre.md). Screens are not built yet.

## Phase 1: Clinic operations (built)

- **Doctors page:** photo, profile, contact, locations, services and timings in one form, with sliders for hours and lunch.
- **Timing automation:** when a doctor's hours change, each upcoming visit outside them moves to the nearest opening with the same doctor, and a patient update is queued. Checked-in visits are never moved, and patients are never switched to another doctor automatically.
- **Needs a person:** visits with no opening stay put and appear in Messages, with a count in the sidebar.
- **Messages page:** every patient update, its channel and its status.
- **Channel rule:** website bookings get email plus the change on their private booking page. Everyone else gets their preferred channel, and "phone" means SMS.
- **Today:** Summary, Patient flow, Needs action, Team now and Team handover can each be opened or closed, and the choice is remembered in that browser.

Known limits:

- Blocked time and leave flag visits but don't move them.
- Deactivating a doctor sends their visits to Needs a person rather than moving them.
- Different hours on different days are still set in Settings > Hours. The Doctors form sets one pattern and warns before overwriting.

## Phase 2: Real delivery

Email is built (feature 2): with Resend configured, booking emails go out in the business's name with a calendar file and the manage link, delivery comes back through a signed webhook, and bounced or complained addresses are suppressed. It has not been tried against the real Resend service. WhatsApp (feature 3) and SMS (feature 4) are built the same way against local capture and fakes; neither has been tried against Meta, MSG91 or Twilio. See `docs/verification/2026-11-19-whatsapp-sms.md`.

| Work | Needs from you |
| --- | --- |
| WhatsApp through Meta Cloud API | Built, untried live. Needs Meta Business verification, a number, approved templates, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` |
| SMS through MSG91 (India) or Twilio | Built, untried live. Needs DLT registration, an approved header and templates (replace the template ids in `message_templates`), `SMS_PROVIDER` and the `MSG91_*` or `TWILIO_*` variables |
| Email through Resend | Built. Needs a Resend account, a verified sending domain, `RESEND_API_KEY`, `EMAIL_FROM` and `RESEND_WEBHOOK_SECRET` |
| WhatsApp | A Business Solution Provider or Meta account, plus approved message templates |
| SMS | A provider and, in India, DLT registration of sender and templates |
| Delivery status | Built for email (`/api/webhooks/resend`); WhatsApp and SMS to follow |
| Contact details | Encrypting destinations with a managed key before going live |

Do this first. Automation that promises to tell patients isn't finished until they are told.

## Phase 3: Patient accounts (built)

- **Sign-in:** one-time code by email or phone at `/portal/sign-in`. Six digits, valid 10 minutes, 5 attempts per code, 5 codes per contact per hour. The account is created only after the code is verified.
- **Portal:** upcoming and past visits at `/portal`, with reschedule and cancel. The private link per booking (`/manage/[token]`) still works.
- **Family:** patient records with the same verified contact appear together, worked out live, so changing a contact on the clinic's record removes access. A dependent with different contact details won't appear.
- **Documents need a second check:** the patient enters a date of birth that matches the clinic's record. After 5 wrong tries, or with no date of birth on file, the patient asks the clinic and staff confirm in Records after checking ID.

Known limits:

- Codes reach patients by email only, and only with Resend configured. Resend has not been tested against the real service; codes now use the shared email templates and provider. Outside production, codes go to the server log. In production, phone sign-in returns an error until SMS exists (Phase 2).
- There is a limit per contact but none per IP address.

## Phase 4: Reports and records (built, not ready for real patient data)

- **Records page:** notes, reports and prescriptions per patient and visit, with PDF, PNG and JPEG files up to 15 MB. It opens from an appointment or a patient profile.
- **Sharing:** draft, then shared, then withdrawn (back to draft). Only drafts can be edited. Only drafts that were never shared can be deleted.
- **Permissions:** owners, admins and doctors only. Doctors see records they created and records of patients with an appointment with them. Only owners and admins see the access log.
- **Access log:** every staff and patient view, file open and change.
- **Storage:** titles, notes, file names and file contents are encrypted. Files are served only through audited routes, never by a public link.

Before real patient data:

| Work | Needs from you |
| --- | --- |
| Managed encryption keys | An AWS account and a KMS key. Per-business keys, rotation and re-encryption are built (feature 10) and run with a local master key; the KMS provider is unit-tested only |
| File storage | An S3 bucket and access. The S3 adapter is built and checked against MinIO |
| Virus scanning | A ClamAV service next to the worker. Built and checked against a local ClamAV |
| Retention and deletion rules | A legal decision. Nothing is deleted automatically |
| Legal review | DPDP Act, medical record rules |

Doctor photos and business pictures now live in the encrypted file store too (feature 10).

## Phase 5: Hospitals, clinics and shared patients

The case: one patient visits a hospital and two clinics.

**Recommended model: each organisation keeps its own record, and the patient controls sharing.**

- **Organisations:** add a type (hospital, clinic) and departments. Row-level security stays per organisation.
- **Person:** one global identity, linked to a separate patient record in each organisation. A shared phone number alone never links records, because families share phones.
- **Patient:** sees all their organisations and visits in one portal, and grants or revokes sharing per organisation.
- **Doctors:** see their own organisation's record by default, and another organisation's only with active consent. Each access is logged. A separate emergency-access rule needs a clinical and legal decision.
- **Public:** the booking pages stay per organisation, with an optional directory later.

Needs legal review before any build: India's DPDP Act, ABDM/ABHA integration, and medical record retention. Kalendr makes no compliance claim today.

## Protected storage (built, feature 10)

- One data key per business, wrapped by a master key (AWS KMS in production, a local key in development). Every encrypted record, file, picture and form answer carries its key version; records from before still open.
- Yearly key rotation by the worker, and **Replace key now** for owners and admins (Settings → Data protection). A re-encryption job moves older items to the new key in batches, then retires old versions.
- Files and pictures in a private, versioned S3 bucket under `tenant/{id}/…`, encrypted before upload, opened only through audited routes.
- ClamAV checks every upload. A pending file shows "Checking file…" and cannot be opened or shared; an infected one is purged and marked; production refuses uploads with no scanner.
- Other features' secrets use the same keys (`src/server/keys/secrets.ts`).
- `compose.yaml` has `minio` and `clamav` (profile `storage`); `scripts/s3-bucket.mjs` sets the bucket up. [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md) covers point-in-time recovery, versioning and a recorded restore drill.

Known limits: real S3, real KMS and a production restore are not verified; a file stays pending if ClamAV is down past 8 attempts; the uploader is told of a virus through the file list and audit log, not a message yet. Details in `docs/OPERATIONS.md`, "Known limits".

## Calendar sync (built, feature 16; real accounts not tested)

- Migration `0031_calendar_sync`: `calendar_connections` (login sealed with the business key, purpose `calendar.credentials`), `calendar_selections`, `external_busy` (start, end, event id; no titles), `appointment_event_links`, `calendar_webhook_events`, `calendar_feed_tokens`, `calendar_conflicts`, `calendar_business_settings`. All have forced row-level security and composite foreign keys. Three definer functions return ids only: `kalendr_resolve_calendar_channel`, `kalendr_resolve_calendar_feed` (web app) and `kalendr_calendar_tenants` (worker only; the release step and the test scripts revoke it from the web role).
- Busy time from a person's ticked calendars removes slots on the booking page and refuses a booking inside it; "free" events do not block; a connection that needs reconnecting is ignored. `getExternalBusy` in `src/server/external-busy.ts` is the read-only call for the slot engine.
- Bookings are written into the staff member's chosen calendar by the worker, with text per business setting (just "Busy" by default, first name and service, or full details; never contact details). A linked event moved or deleted outside raises a "Needs a person" item with two actions; the appointment is never changed by itself.
- Private subscribe-only `.ics` feed per staff member (`/api/calendar-feed/<token>.ics`), 256-bit token, only its hash stored, rate limited.
- Needs the owner's accounts: Google OAuth client (calendar scope verification), a Microsoft app registration, `CALENDAR_WEBHOOK_TOKEN`. See `.env.example`. `CALENDAR_PROVIDER_MODE=fake` runs everything on in-memory test calendars and is refused unless `BETTER_AUTH_URL` is localhost.

Known limits: no real Google, Outlook or iCloud account has been used, only the fake adapter and scripted transports. A connection that was "Needs reconnecting" while bookings were made does not back-fill their events when it is fixed. Changing the event-text setting rewrites future events only. Plan limits (feature 14) are a constant of 3 accounts per person. Moving an appointment to match an outside event runs the normal reschedule, so a time outside the person's hours is refused with the usual message. A booking made by staff on a time that is busy in their own calendar is refused like a schedule block.

## Monitoring, browser tests and CI (built, feature 35)

- Start-up check of every environment variable; production stops and names what is missing.
- pino JSON logs with request id, tenant and route; phone numbers, emails, names, tokens, codes, message bodies and the values of a failed database query redacted (unit-tested). Errors Next.js prints with `console.error` go through the same redaction.
- Sentry and OpenTelemetry, both off unless their variables are set; events scrubbed of personal data and tagged with the request id.
- `/api/health` and `/api/ready`; worker heartbeat log with queue depth, oldest pending age and dead letters.
- Playwright journeys on desktop and phone with an axe scan; CI runs them on every pull request.
- One container image for web, worker and the release step. `docs/OPERATIONS.md` holds deploy, roll back, restore, secret rotation, alerts and the release checklist.

Known limits:

- The worker now has a production mode (feature 1) but no provider adapters. Until features 2–4 add them, every message in production mode goes to dead letter as `provider_not_configured`.
- `.github/workflows/ci.yml` has never run on GitHub: no GitHub repository exists for this project yet. It was checked only on this machine: the YAML parses, and each step's command passed when run by hand (install, lint, typecheck, unit tests, knip, dependency audit, the PostgreSQL 18 acceptance, build, a fresh journey database and `pnpm exec playwright test`, the image build and its two checks). The GitHub-only parts (the actions, the `postgres` service container, the browser cache) and actionlint were not checked. A failing journey blocks a merge only once the repository exists and the owner makes the checks required (`docs/OPERATIONS.md`, "Branch protection").
- The axe scan skips four findings that come from vendored components: coss calendar weekday header contrast, coss segmented control contrast, react-day-picker day buttons whose name is the full date, and the coss destructive button (white on the light theme's red-500, 3.8:1 where 4.5:1 is needed; seen on the cancel dialog at phone width). They are listed in `e2e/support/journey.ts` and still attached to every report. The destructive one is a real contrast failure and needs a darker `--destructive` token, which changes every destructive button, so it is left for a design pass.
- The manage page announces "has been moved to the new time" twice (an `aria-live` paragraph and an `Alert role="status"` in `manage-booking.tsx`), so a screen reader reads it twice.
- Errors a page throws get their request id when they are reported, since nothing upstream sets `x-request-id` on page requests. The id is on the Sentry event and on the matching log line, not on the error screen. Next.js reports one page error twice (two log lines, two ids); Sentry keeps one event.
- Next.js copies the local `.env` into `.next/standalone/`, so running `node .next/standalone/server.js` on a developer machine picks up local secrets. The container image is built without any `.env` (`.dockerignore`).
- knip reports 61 unused exports and 16 unused exported types as warnings, not failures. Review them before they grow; the vendored coss folders are excluded.
- Playwright runs `next start` against the standalone build, which prints a warning; the container uses `node server.js`.
- `KALENDR_RECORDS_KEY` was the only records key; feature 10 replaced it with per-business keys and rotation.

## Staff workspace upgrade (built, feature 31)

- Staff data goes through react-query (`src/features/clinic/queries/`): one key per list (`keys.ts`), fetchers, and mutations that change the screen at once and roll back on a refusal. `staff-snapshot-provider.tsx` now reads the same cache, so every screen gets refresh-on-focus; only the schedule, the palette and the bulk actions use the mutations directly. The other screens move one at a time.
- Schedule: day by staff, day by room, week and list. View, date, range, location, filters, search and the open appointment are in the address bar (`nuqs`). Drag a visit to move it (or to another staff member's row), drag its end to change its length; the server checks the version and the clash, a refusal puts the card back with the reason, and an Undo toast stays for 8 seconds. The dialog that appears after a drop asks whether to tell the customer; its default is the business's "Tell customers when you move them" setting.
- Command palette on a debounced server search (name, phone or email, partial), plus date jumps ("tomorrow", "mon", "16 nov"). Shortcuts: `N`, `T`, arrows, `/`, `?`; never while typing or with a dialog open.
- List view: windowed rows, select several, move to another staff member or cancel with a reason (one at a time, each with its own version; a refusal on one never stops the rest).
- Phone: bottom bar, the day as a vertical list. Theme: light, dark or follow the device (account menu), stored in the `kalendr-theme` cookie. Day sheet to print at `/print/day`.

Known limits:

- Live updates (feature 32) do not exist yet. The schedule refetches on window focus and after every change; `keysForLiveEvent` in `queries/keys.ts` is where an event will be mapped to the keys to invalidate.
- Team routing (feature 20) does not exist yet. Dragging across staff rows uses the existing reschedule route, which refuses a staff member who does not offer the visit's service.
- "Tell the customer" is recorded as `notifyCustomer: false` in the appointment's outbox payload and audit row when staff untick it. Nothing sends reschedule messages until the production worker (feature 1) exists, and that worker has to read the flag.
- Bulk "Message" lists the selected customers with their numbers and copies them. Sending from the schedule arrives with the messaging inbox (feature 3).
- Resizing a visit and the preview: in preview mode a drag still goes to the appointment page for review and cannot change the length.
- A dark theme chosen as "match this device" paints light for a moment on a full page load: only the stored light and dark choices can be drawn by the server.
- The schedule's week and day-by-room views are KLOQ grids that draw every event. They stay smooth to a few hundred visits on a day (see the verification note); the list view draws only the rows in view.

## Staff sign-in options and second factor (built, feature 6)

Details, settings and known limits are in [staff-sign-in.md](staff-sign-in.md). Migration to apply: `0038_staff_second_factor` (`auth_two_factors`, `auth_passkeys`, `auth_known_devices`, `auth_users.two_factor_enabled`, `auth_sessions.second_factor_at`, `tenants.security_policy`). Real Google and Microsoft sign-in need the owner's OAuth apps.

## Branding and own web address (built, feature 13)

Details and known limits are in [branding-and-address.md](branding-and-address.md). Migration to apply: `0055_branding_domains`  (`tenants.brand`, `tenant_domains` check columns, `tenant_embed_origins`, the `kalendr_domain_*` and `kalendr_embed_origins` functions). Needs a host that supports custom hostnames and asks `/api/internal/domain-check` before issuing a certificate.

## Onboarding 2.0 (built, feature 11)

Details and known limits are in [onboarding.md](onboarding.md). Migration to apply: `0056_onboarding_progress`  (`onboarding_progress`, `appointments.is_test`, `patients.is_test`, `tenants.onboarding_started_at`, `kalendr_onboarding_tenants`, `kalendr_purge_test_rows`, `admin_onboarding_funnel`). Reports (feature 24) must leave out `is_test` bookings.

## Library upgrades

Minor and patch upgrades are done. These major versions were held back, and each should be its own tested change:

| Package | Current | Latest | Note |
| --- | --- | --- | --- |
| `@hookform/resolvers` | 5.9 | 7.0 | Used by forms |
| `eslint` | 9 | 10 | Check plugin support first |
| `postgres` | 3.4 | 4.0 | Database driver: run `scripts/verify-postgres18.sh` after |
| `typescript` | 5.9 | 7.0 | Check tooling support first |
| `vitest` | 4 | 5 | Test runner |
| `@types/node` | 20 | 26 | Should match the Node version in use |

## Local setup note

`scripts/local-db.sh` fails because the Homebrew PostgreSQL binaries are gone. Use `scripts/verify-postgres18.sh` to verify against a disposable database, or reinstall PostgreSQL.

## Online payments (feature 23)

- Migration `0042_online_payments`: `tenant_payment_accounts`, `tenant_payment_policies`, `payment_orders`, `refund_requests`, `payment_events`, `payment_mismatches`; new columns on `services`, `appointments`, `payments`, `payment_refunds`; appointment statuses `pending_payment` and `expired`. Definer functions `kalendr_resolve_payment_account`, `kalendr_resolve_stripe_account` (web app) and `kalendr_payment_tenants` (worker only). Details and known limits: [online-payments.md](online-payments.md).

## Embeds, staff notifications and AI access (features 52, 56, 54)

- Migrations `0063_embeds` and `0064_staff_notifications` to apply. Feature 54 needs no migration. See [embeds-and-conversion.md](embeds-and-conversion.md) and [staff-notifications.md](staff-notifications.md).
## Scheduling trust and wording (features 44, 45, 48, 50)

- Migrations `0057_spam_protection`, `0058_special_links`, `0059_service_templates`, `0060_calendar_wording` (see [scheduling-trust-and-wording.md](scheduling-trust-and-wording.md)). New function `kalendr_resolve_special_link` is for the web app, so it is not on any REVOKE list. No new worker function and no new environment variable; the blocklist key is derived from `BETTER_AUTH_SECRET`.

## Invoices, receipts and GST (built, feature 24) and packages, memberships and coupons (built, feature 25)

Details, settings and known limits are in [invoicing-and-gst.md](invoicing-and-gst.md) and [packages-and-coupons.md](packages-and-coupons.md). Migrations to apply: `0053_invoicing` (`tax_settings`, `service_tax_rules`, `invoices`, `invoice_lines`, `invoice_counters`, `credit_notes`, `credit_note_lines`, `invoice_documents`, `invoice_links`; `payments` gains `patient_id`, `location_id`, `invoice_id` and a nullable `appointment_id`; `kalendr_resolve_invoice_link`) and `0054_packages_coupons` (`packages`, `customer_packages`, `customer_credits`, `membership_plans`, `customer_memberships`, `membership_events`, `coupons`, `coupon_redemptions`, `appointment_discounts`; `kalendr_offers_tenants`). Built on a branch whose reserved numbers were 0061 and 0062; the journal test needs contiguous numbers, so they carry 0053 and 0054 until the integrator renumbers them.

- Feature 29, search and discovery: [search-discovery.md](search-discovery.md). Migration `0074_search_discovery` (searchable routing forms; `tenants.listed`, `tenants.seo`, `pg_trgm` and `btree_gin` indexes, `kalendr_staff_search`, `kalendr_sitemap_entries`, `kalendr_sitemap_count`, `kalendr_directory_search`, `kalendr_directory_facets`, `kalendr_subscription_serves`; all called by the web app, none on a REVOKE list). Chained after 0073 (routing forms). No new environment variable.
- Feature 55, app marketplace: [app-marketplace.md](app-marketplace.md). Migration `0071_apps_marketplace` . No new worker function or environment variable.
- Feature 57, browser extension: [browser-extension.md](browser-extension.md). Migration `0072_device_signin` (`oauth_device_codes`, six `kalendr_device_*` functions for the web app; none on a REVOKE list). Built by `pnpm build:extension`, part of `pnpm check`.
- Feature 46, routing forms: [routing-forms.md](routing-forms.md). Migration `0073_routing_forms` (four tables, `campaigns_rule_ck` widened; no SQL function, no environment variable).
- Migration `0070_ai_assistant` to apply (feature 30). The assistant stays off until `ANTHROPIC_API_KEY` is set and an owner switches a channel on. See [booking-assistant.md](booking-assistant.md).
- Migration `0067_enterprise` to apply (feature 53: teams, custom roles, verified domains, SSO connections, directory tokens, attributes, organisation defaults, the last-owner rule). New worker-only functions `kalendr_email_domain_tenants()` and `kalendr_keep_one_owner()` are in the REVOKE lists. See [enterprise-and-teams.md](enterprise-and-teams.md).

## Customer profiles (built, feature 27) and campaigns (built, feature 28)

Details and known limits: [customer-profiles.md](customer-profiles.md) and [campaigns.md](campaigns.md). Migrations to apply: `0068_customer_profiles` (tags, notes, segments, extra fields, merges, the block and merge columns on `patients`, `pg_trgm` search indexes, `kalendr_crm_tenants`) and `0069_campaigns` (`campaigns`, `campaign_sends`, `marketing_preferences`, the `unsubscribe_link` consent source, marketing templates, `kalendr_campaign_tenants`, `kalendr_resolve_unsubscribe`). `pg_trgm` is a trusted extension, so the database owner can create it; where it cannot, create it once as a superuser before migrating. The release scripts revoke the two worker-only functions from the web role.

Needs your credentials before it can go live: an email sending domain (Resend, verified), WhatsApp marketing templates approved by Meta (`campaign_recall`, `campaign_birthday`, `campaign_winback`, `campaign_package`, `campaign_offer`) and DLT approval for the promotional text template `campaign_message`.
