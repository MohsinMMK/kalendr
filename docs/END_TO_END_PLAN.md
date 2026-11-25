# Kalendr end-to-end local delivery plan

> Kalendr now serves any appointment-led business, not only clinics. This plan was written for clinics and says "clinic" and "patient" throughout; read them as business and customer. Database tables keep those original names (`patients`, `practitioners`). `scripts/seed-local-db.mjs` now seeds a salon (`cedar-hair`) beside the dental (`lotus-dental`) and healthcare (`riverbend-care`) businesses (see [LOCAL_DATABASE.md](LOCAL_DATABASE.md)).

Status: implementation in progress. This plan tracks a real local database flow separately from the existing browser preview. A checked box requires the acceptance evidence named below; the older `PHASE_PLAN.md` describes the preview build and is not a database-mode acceptance report.

## Latest evidence — 10 October 2026

The original phase descriptions below are the delivery baseline, not a current
inventory of missing code. [9 October onboarding acceptance](verification/2026-10-09-onboarding.md)
records a real registration → setup → public request → staff approval journey.
[10 October refinement](verification/2026-10-10-saas-refinement.md) adds a clearer
four-stage registration flow, a working landing tour, selectable open days,
and tenant-specific website snippets in database mode. Website installation and
frame-origin approval remain external steps; generating a snippet does not save
or approve the origin.

PostgreSQL 18.6 now passes the disposable migration, seed, runtime-isolation,
and four appointment integration cases with `scripts/verify-postgres18.sh`.
The native development cluster remains 17.11; production restore acceptance is
still pending. Blocked time is already implemented in `schedule_blocks` and
covered by the integration suite. The local capture worker is implemented and
documented in [WORKER.md](WORKER.md), with policy unit coverage; a full database
worker lease/retry/deduplication acceptance run remains pending. Recurring
series, persistent handover notes, automated reminder scheduling, saved website
plans, and live provider delivery remain open.

## Current foundation and gaps

| Layer | Existing foundation | Missing for an end-to-end clinic flow |
| --- | --- | --- |
| Database | Migrations, forced tenant RLS, tenant foreign keys, scheduling exclusions, isolated roles/seed, PostgreSQL 18.6 integration acceptance | Production restore and deployed-runtime acceptance |
| Identity | Better Auth, protected staff routes, membership/role resolution, owner registration and sign-in | Hosted verification delivery and production identity acceptance |
| Patient booking | Tenant catalog by slug, live availability, transactional booking, manage tokens, conflict/version handling | Broader restart and deployed-runtime acceptance |
| Staff operations | Database-backed appointments, patients, hours, blocked time, waitlists, recalls and booking modes | Recurring series, persistent handover notes, online-booking flags and reminder choices |
| Notifications | Transactional outbox, bounded local capture worker, retries/leases and policy tests | Full database worker acceptance and actual provider delivery |
| Website setup | Preview plans and actual-tenant hosted/inline/popup snippets, with explicit origin-approval boundaries | Persistent website plans, external installation and deployed frame-origin approval |

## Phase 1 — Isolated database and fixture [locally verified]

- [x] Start PostgreSQL in a project-specific local cluster or Compose volume, without touching any existing or production database.
- [x] Apply migrations with a privileged local migration role; use a separate non-owner, non-bypass-RLS runtime role.
- [x] Seed at least two clinics, locations, practitioners, resources, services, rules, and distinct staff users/memberships. Seeds must be idempotent and carry no live patient data.
- [x] Prove a runtime connection can read only within a transaction-scoped tenant, while a cross-tenant join or reference fails.

Acceptance: `scripts/local-db.sh start|migrate|seed|check` against native PostgreSQL 17.11 on `127.0.0.1:5544`; `scripts/verify-postgres18.sh` independently passed against disposable PostgreSQL 18.6 on `127.0.0.1:5545`.

## Phase 2 — Identity and tenant boundary

- [x] Add staff sign-in/sign-out surfaces for the configured Better Auth provider, with explicit loading and failure states.
- [x] Resolve the session on the server; require an active membership before any staff page/API data read or mutation. Choose only a tenant from that user's memberships; never trust a browser tenant header or clinic ID.
- [x] Enforce role capability checks (read-only cannot write; administrative settings require admin/owner; scheduling actions require an allowed clinical/front-desk role).
- [x] Keep browser preview deliberate and visibly labeled. Database mode must never use demo or `sessionStorage` as a fallback when the database is unavailable.

Acceptance: anonymous staff requests redirect or return 401; an inactive/non-member user is denied; clinic A staff cannot read or mutate clinic B records by guessing IDs, including patient IDs and appointment IDs. Local owner registration and browser sign-in are recorded in the October onboarding evidence; deployed-runtime identity acceptance remains separate.

## Phase 3 — Shared patient, catalog, and appointment authority

- [x] Resolve each public booking slug to its real active tenant and tenant-owned catalog before rendering the patient flow.
- [x] Add tenant-scoped staff bootstrap/catalog, patient directory/search/create, appointment list/detail, staff booking, status, reschedule, cancel, check-in, complete, and no-show routes backed by PostgreSQL.
- [x] Reuse the database scheduling rules, exclusion constraints, idempotency, version checks, audit and outbox in every mutation. New patient and appointment creation must commit together.
- [x] Point staff Today, Schedule, Patients, New appointment, and appointment task screens at shared server data in database mode, with genuine loading, empty, conflict, stale-version, and retry states.

Acceptance: the 9 October browser record proves public request → signed-in staff Schedule → approval. A broader Today/Patients lifecycle and server-restart acceptance remain open. Visit start, handover notes, and owner assignment are preview-only overlays and are not stored as clinic statuses.

## Phase 4 — Remaining visible operations and settings

- [x] Persist waitlist offers/closures, recall contacted/snoozed states, and service booking modes in tenant-owned tables.
- [x] Persist working hours for practitioners from setup, Team, and Settings → Availability.
- [x] Persist blocked time; prove its availability effect with the database integration suite.
- [ ] Persist recurring series, handover notes, online-booking flags, reminder choices and website setup plans in tenant-owned tables.
- [x] Make saved service booking modes affect public booking (instant vs request). Online-booking toggles are still preview-only.
- [x] Distinguish database-saved configuration from external website installation and deployed CSP/origin approval. Tenant-specific installation code is available; website plans and approved origins are not saved by the guide.

Acceptance remaining: recurring series, reminder provider settings, saved website plans, and website origin approval still cannot be honestly saved. Those flows are labeled rather than written to `sessionStorage` in database mode.

Clinic self-registration is available locally at `/start` without enabling generic Better Auth signup. Production registration stays closed unless `KALENDR_ALLOW_CLINIC_REGISTRATION=true`, and still needs email verification, abuse controls, and legal copy before a live host.

## Phase 5 — Notifications and local delivery proof

The database run that closes these boxes was recorded on 2026-11-12 in
`docs/verification/2026-11-12-production-worker.md`. It ran
`src/worker/outbox-worker.integration.test.ts` as the real `kalendr_worker` role
on the local cluster and in `scripts/verify-postgres18.sh`.

- [x] Claim due outbox rows using a bounded lease and `FOR UPDATE SKIP LOCKED`; retry transient failures with backoff, dead-letter exhausted work, and use semantic dedupe.
  - Two workers handle 41 rows with no overlap.
  - Retries come at 5, 10 and 20 s; the 8th attempt goes to dead letter.
  - An expired 60-second lease is taken over.
- [x] Re-read current appointment/version/status before sending confirmation or reminder content. Local capture transport records output without external delivery. A reminder for a moved appointment is dropped; the new version's reminder is captured once.
- [x] Keep external email/SMS/WhatsApp adapters disabled until sender credentials, consent wording, rate limits and live transport tests are authorized. Production mode exists, but there are no adapters, so it dead-letters as `provider_not_configured`. Tests and local runs use `local_capture` only.

Acceptance: local worker processes a booking event once semantically, retries a simulated failure, suppresses obsolete reminders, and records capture delivery status. No external message is sent during local tests.

## Phase 6 — End-to-end verification and handoff

- [ ] Run `pnpm check`, migration/seed checks, database integration tests with the non-owner runtime role, and a real-browser clinic A public booking to clinic A staff lifecycle.
- [ ] Verify tenant B isolation, browser/server restart persistence, concurrent booking conflict, malformed/stale mutation behavior, and desktop/mobile accessibility on database mode.
- [ ] Document exact start, migrate, seed, sign-in, worker, test, and reset commands and the production release gates.

Acceptance: evidence is tied to the running local database and actual HTTP/browser flows, not to green preview component tests alone.

## External gates before a live clinic

No deployment destination, domain, production PostgreSQL, staff identities, sender identities/providers, retention policy, consent wording, legal review, or operational incident owner has been supplied. These are required for production activation, along with verified backups/restore, tenant isolation under the deployed runtime role, TLS/CSP/custom-domain setup, provider delivery tests, observability, and release authorization. The local implementation must record these as remaining gates rather than claim them complete.
