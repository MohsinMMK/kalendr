# Privacy centre (feature 7)

Tools to help a business meet its duties to its customers' information: separate consent choices, a copy of a
customer's data, erasure with a plain account of what was kept, retention periods, and a breach runbook. This page is
the backend. The screens (customer portal "Privacy", staff "Privacy requests" and Settings "Privacy") are built from the
API contract below.

Date: 19 November 2026. Backend and screens built 19 November 2026 (screens: portal /portal/privacy, Settings, Privacy, and /settings/privacy-requests).

## What is built

| Part | Where |
| --- | --- |
| Tables, trigger, definer functions | `drizzle/0039_privacy_centre.sql`, `src/db/schema.ts` (new section at the end, plus guardian columns on `patients`) |
| Rules with no database (consent defaults, minors, deadlines, retention defaults, erasure wording) | `src/server/privacy/rules.ts` |
| Consent: record, withdraw, current choices, the gate | `src/server/privacy/consent.ts` (web), `gate.ts` (worker) |
| Notice text, in English and Hindi, and the public function | `src/server/privacy/notice.ts` |
| Requests: create, list with days remaining, decide | `src/server/privacy/requests.ts` |
| Customer-side functions | `src/server/privacy/portal.ts` |
| Export zip (JSON and PDF) | `export.ts`, `pdf.ts` |
| Erasure | `erasure.ts` |
| Retention (nightly) and overdue alerts | `retention.ts`, `retention-settings.ts`; jobs in `src/worker/jobs.ts` and `schedules.ts` |
| Processing summary | `summary.ts` |
| Breach window list | `breach.ts`, and the function `kalendr_breach_affected` |
| Worker handlers | `src/worker/handlers/privacy.ts` |
| Emails | `src/emails/privacy-export-ready.tsx`, `privacy-erasure-done.tsx`, `privacy-request-overdue.tsx` |
| Runbook | [INCIDENT_RUNBOOK.md](INCIDENT_RUNBOOK.md) |

### Tables

| Table | Holds |
| --- | --- |
| `consent_records` | One row per consent given or withdrawn: customer, purpose, granted, wording version, source, a fixed actor word and the staff user id. Never changed or removed: a trigger refuses `UPDATE` and `DELETE` for the app role, the worker role and the table owner. Ids and fixed words only, no names and no free text. |
| `privacy_notices` | A business's own notice text per version and language. With no row the built-in text in `notice.ts` is used. There is no screen or API to write these yet (see Known limits). |
| `data_requests` | Download, erasure or correction request: status, due date (90 days after it is made), who handled it, a fixed reason word, an optional note for the customer (kept out of the audit log), the plain-language result of an erasure, a `version` for edits, and `overdue_alerted_at`. A partial unique index allows one open request per customer and type, which is what makes a double submit harmless. |
| `data_exports` | One built export per request: the encrypted file's key, `sha256` of the one-time token (the token itself is never stored), `expires_at` (7 days), `used_at`, size. |
| `retention_policies` | The owner's own periods. A missing row means the default for the business type (`defaultRetention` in `rules.ts`). |

`patients` gains `guardian_name`, `guardian_relationship`, `guardian_contact_ciphertext` (sealed with the business data key, purpose `patient.guardian-contact`), `guardian_key_version`, `guardian_consented_at` and `erased_at`.
`patients.privacy_accepted_at` and `messaging_consent_at` stay as quick lookups: `recordConsentIn` keeps them in step (appointment messages switch `messaging_consent_at`; the first yes sets `privacy_accepted_at`) and writes the consent row and an audit row in the same transaction. Migration 0031 backfills one `appointment_messages` row for every customer who already had `messaging_consent_at`.

All five new tables have forced row-level security, a `tenant_isolation` policy, a `(tenant_id, id)` unique key and composite foreign keys to `patients` or `data_requests`.

### Consent rules (the gate)

Purposes are never bundled: `appointment_messages`, `marketing_messages`, `reviews`, `records_sharing`.

| Purpose | Default when the customer has said nothing |
| --- | --- |
| `appointment_messages` | on until withdrawn |
| `reviews` | on until withdrawn |
| `records_sharing` | on until withdrawn |
| `marketing_messages` | **off**: needs a clear yes |

The latest row for a purpose is the answer. Withdrawing marketing never affects appointment messages.

```ts
import { canSendMarketing, hasConsent, withdrawConsent, recordConsent } from "@/server/privacy/consent";
await canSendMarketing(tenantId, patientId);                       // the one question a campaign asks
await hasConsent(tenantId, patientId, "appointment_messages");
await withdrawConsent(tenantId, patientId, "marketing_messages", { source: "whatsapp_stop" });
// in the worker, with a postgres.js tenant transaction:
import { canSendMarketingTenantDb } from "@/server/privacy/gate";
```

`canSendMarketing` is false when the customer has not said yes, has withdrawn, is under 18 (date of birth) or is marked as a dependant (`is_dependent`), or has been erased. Granting marketing for such a customer is refused with `minor_no_marketing`, and a row written around the rules still cannot open the gate. A choice made in the portal for someone under 18 needs a guardian on file first (`guardian_required`); the guardian's contact is stored sealed.

### Export

A customer asks in the portal (they must have entered a sign-in code in the last 15 minutes). The route writes a request already marked approved and one `privacy.export.requested` outbox row. The worker builds `README.txt`, `data.json` (the complete copy) and `summary.pdf` (readable) with `fflate`, seals the zip with the business's data key, stores it under `tenant/{id}/export/{id}` in the private file store, saves the SHA-256 of a 256-bit token, and emails `{origin}/api/portal/privacy/export/{token}`. The link works once and for 7 days.

It contains: profile, consent history and current choices, bookings (with notes and answers), form answers, the record of messages sent (when, channel, outcome; message text is not stored anywhere), payments and refunds, reviews, waiting list, follow-ups, earlier privacy requests, and records shared with the customer. Shared records are included only once the customer has confirmed who they are in the portal, as in the portal itself. Attached files are listed by name, not included.

**PDF choice.** `docs/build-plan/LIBRARIES_AND_APIS.md` names `@react-pdf/renderer` only for feature 24 (invoices). To avoid a large dependency and an embedded font for one readable summary, `pdf.ts` is a minimal text-PDF writer (A4, built-in Helvetica). Letters outside Western European print as `?`; `data.json` in the same zip is always the complete copy, and the README and the PDF say so. Feature 24 can replace it.

### Erasure

A customer asks; staff approve or refuse with a reason (approving an erasure needs a second-factor check from the last 10 minutes). Approval only queues `privacy.erasure.approved`; the worker then, in one transaction:

- anonymises the customer in place (`Erased customer`, phone `erased`, email `erased-{id}@erased.invalid`, no date of birth or access needs, guardian removed, `erased_at` set). The row stays because bookings, payments and records point at it.
- clears notes, reason for visit, extra answers and the private manage link on their bookings; empties form answers; deletes the message log, waiting list and follow-ups; removes the name and comment on their reviews; clears saved copies in the outbox and in idempotency keys; deletes earlier export files and the portal link rows; removes their sign-in account when it opens nothing else.
- **keeps** payments and refunds (never edited; kept for the billing period), visit records that are inside the business's records period (removed later by the nightly job once that period passes), and consent history.
- replaces personal fields inside old audit rows through `kalendr_scrub_audit_personal`. No audit row is ever deleted. It changes only a fixed list of top-level metadata keys (`name`, `firstName`, `lastName`, `patientName`, `displayName`, `phone`, `email`, `contact`, `destination`, `dateOfBirth`, `guardianName`, `guardianContact`, `address`) on rows about that customer, and any row holding the customer's exact full name, phone or email.
- writes the plain summary (what was removed, what was kept and why) on the request, audits `privacy.erasure.completed` with counts only, and emails the customer that summary. The address is read before it is cleared. If the email needs a retry the whole run is rolled back and tried again.

Free text never goes to the audit log: the approval row holds the request id, the type, a fixed reason word and the customer id.

### Retention

`retention_policies` kinds and defaults (owner can change the editable ones; the defaults are starting points, not legal advice):

| Kind | Default | Action | Editable | Applied by nightly job |
| --- | --- | --- | --- | --- |
| `login_codes` | 1 day | delete | no | yes, once per run for all businesses (the codes belong to no business) |
| `message_log` | 365 days | delete | yes (30 to 3650) | yes |
| `cancelled_booking_details` | 730 days | anonymise | yes | clears notes, reason and extra answers on cancelled and no-show bookings |
| `finished_outbox` | 30 days | delete | yes, shorter only (7 to 30) | yes (the older `retention` job also removes them at 30 days) |
| `medical_records` | 7 years for healthcare and dental, 3 years otherwise | delete | yes | only for customers who were erased |
| `billing_records` | 8 years | anonymise | yes | not applied: payments are never edited. Used to tell an erased customer how long they are kept |

The job is `privacy-retention` at 03:20 UTC. For each business that had something removed it writes one `privacy.retention.applied` audit row with the counts. The count of sign-in codes and ended customer sessions removed is in the job's log line (`loginCodes`, `loginSessions`) and is returned by `applyPrivacyRetention`.

### Overdue alert

`privacy-overdue` runs daily at 04:00 UTC. For each open request past its due date that has not been mentioned yet, it sets `overdue_alerted_at`, writes an audit row and queues `privacy.request.overdue`; the handler emails the business's own address once.

## API contract

All responses use the usual envelope: success `{ "data": ... }`, failure `{ "error": { "code", "message", "fieldErrors?" } }`. Times are ISO 8601 strings. All routes are `no-store`.

### Customer (portal session cookie)

A customer account can open several businesses and several people (themselves and dependants). Every call names the person with `clinicSlug` and `patientId` from `GET /api/portal/privacy`; any pair that does not belong to the signed-in account answers 404 `not_found`.

**GET `/api/portal/privacy?language=en|hi`** (any signed-in customer)

```json
{ "data": {
  "noticeVersion": "2026-11",
  "people": [{
    "clinicSlug": "lotus-dental", "clinicName": "Lotus Dental", "patientId": "…", "name": "Asha Rao",
    "isMinor": false, "guardianOnFile": false,
    "consents": [{ "purpose": "appointment_messages", "granted": true, "answered": false, "wordingVersion": null, "since": null }],
    "requests": [{ "id": "…", "type": "export", "status": "completed", "createdAt": "…", "dueAt": "…", "daysRemaining": null,
      "overdue": false, "decisionReason": "verified", "decisionNote": null, "decidedAt": "…", "completedAt": "…",
      "summary": null, "version": 3 }]
  }],
  "notices": { "lotus-dental": { "version": "2026-11", "language": "en", "title": "…", "isDefault": true,
    "purposes": { "marketing_messages": { "label": "News and offers", "text": "…" } }, "paragraphs": ["…"] } }
} }
```

Erased customers are not listed. `summary` on a completed erasure is `{ removed: string[], kept: string[] }`.

**PUT `/api/portal/privacy/consents`** (portal session). Rate limit 60 per hour per account.

Body: `{ clinicSlug, patientId, purpose, granted, wordingVersion, guardian? }`, where `guardian` is `{ name, relationship, contact }` and is needed the first time anyone chooses for someone under 18. One purpose per call. Returns `{ consents: ConsentState[], changed: boolean }`; saying what is already true returns `changed: false` and writes nothing.
Errors: 400 `validation_error`; 403 `minor_no_marketing`; 404 `not_found`; 409 `guardian_required`; 429 `rate_limited`.

**POST `/api/portal/privacy/requests`** (portal session). Rate limit 10 per hour per account.

Body: `{ clinicSlug, patientId, type: "export" | "erasure" | "correction", note? }` (note up to 500 characters). An `export` or `erasure` needs a sign-in code entered in the last 15 minutes: otherwise 403 `fresh_code_required` and the screen sends the customer back through `POST /api/portal/auth/request` and `verify`. Returns **201** `{ request, created: true }` for a new request, or **200** `{ request, created: false }` when the customer already has an open request of that type (a double submit). An export starts as `approved`, and an email with the download link follows within a minute.
Errors: 400, 403 `fresh_code_required`, 404, 429.

**GET `/api/portal/privacy/export/{token}`** (the link in the email; no sign-in). Rate limit 30 per hour per IP. Returns the zip (`application/zip`, attachment `my-data.zip`) once. A used, expired or unknown link answers **410** `link_expired` with the same words each time. Reopening a request after the link has gone: ask for a new export.

### Staff (staff session)

**GET `/api/staff/privacy/requests?status=open|closed|all&type=export|erasure|correction&overdue=true|false`** needs `privacy.manage`. Default `status=open`. Ordered by due date, oldest first, at most 200.

```json
{ "data": { "requests": [{ "id": "…", "type": "erasure", "status": "requested", "createdAt": "…", "dueAt": "…",
  "daysRemaining": 41, "overdue": false, "decisionReason": null, "decisionNote": null, "decidedAt": null, "completedAt": null,
  "note": "what the customer wrote", "summary": null, "version": 1,
  "patientId": "…", "customerName": "Asha Rao", "requestedVia": "portal", "handledByUserId": null }],
  "counts": { "open": 3, "overdue": 1 } } }
```

`daysRemaining` is null once a request is closed and negative when overdue. `customerName` is `Erased customer` after erasure.

**PATCH `/api/staff/privacy/requests/{id}`** needs `privacy.manage` and an `Idempotency-Key` header.

Body: `{ decision: "approve" | "refuse", reason, note?, version }`. Approving uses `reason: "verified"`; refusing uses one of `legal_retention`, `identity_not_confirmed`, `not_this_business`, `duplicate`, `unreasonable`, `other`. `version` is the request's version on screen. Only a request in status `requested` can be decided (downloads are approved automatically). Approving an erasure queues the worker and returns status `approved`; approving a correction marks it `completed` (the staff member makes the correction on the customer's record); refusing returns `refused`. Returns the updated request in the staff shape.
Errors: 400 `invalid_idempotency_key` or `validation_error`; 403 `forbidden`; 403 `step_up_required` or `second_factor_required` (erasure approval needs a second-factor check from the last 10 minutes; the screen asks for a code and repeats the call); 404; 409 `version_conflict` (reload), 409 `already_decided`, 409 `idempotency_conflict`; 409 `preview_only`.
`decisionNote` is shown to the customer and is never copied into the audit log.

**GET `/api/staff/privacy/retention`** needs `privacy.manage` or `settings.manage`.
**PUT `/api/staff/privacy/retention`** needs the same and a second-factor check (403 `step_up_required`). Body `{ policies: [{ dataKind, keepDays, action: "delete" | "anonymise" }] }`; send only the kinds that changed. Both return `{ policies: [{ dataKind, keepDays, action, isDefault, label, description, editable, minDays, maxDays }] }` for every kind. 400 `validation_error` when a period is out of range or the kind is not editable. The audit row holds the kind and the numbers only.

**GET `/api/staff/privacy/summary`** needs `privacy.manage` or `settings.manage`. Returns `{ collected: [{ what, why, keptFor }], sharedWith: [{ provider, receives, why, active }], retention }`.

The permission is `privacy.manage` (owner and admin by default; switchable per person in Team).

### Public

**GET `/api/public/privacy-notice?clinic={slug}&language=en|hi`** no sign-in; 120 per minute per IP. Returns one notice object (same shape as in `notices` above). An unknown slug returns the built-in text, so it does not reveal which businesses exist. Server code can call `getPrivacyNotice(tenantId, language)` or `getPublicPrivacyNotice(slug, language)` from `src/server/privacy/notice.ts`.

## Hand-offs (other lanes call this work; it does not do theirs)

- **Campaigns (messaging lane):** before sending any marketing message, call `canSendMarketing(tenantId, patientId)` (web) or `canSendMarketingTenantDb(tenantDb, tenantId, patientId)` (worker). Do not read `messaging_consent_at` for marketing. Reminders and booking messages must not call it.
- **STOP on WhatsApp and SMS (messaging lane):** call `withdrawConsent(tenantId, patientId, "marketing_messages", { source: "whatsapp_stop" })` (or `"sms_stop"`). Repeats are ignored. Use `"appointment_messages"` only if the customer asked to stop those too.
- **Consent notice at public booking (scheduling lane):** show `GET /api/public/privacy-notice?clinic=…` next to separate boxes, and write each choice with `recordConsent(tenantId, { …, source: "booking", actor: { type: "patient" } })` using the notice's `version` as `wordingVersion`. Today the booking flow still writes `privacy_accepted_at` and `messaging_consent_at` directly, which leaves no consent row for them (a customer with no row is treated as the default above).
- **Staff booking:** `recordConsent(... source: "staff", actor: { type: "staff", userId })` when the desk records consent.
- **Admin console (feature 15):** a "who was affected" action over `kalendr_breach_affected` (see `src/server/privacy/breach.ts`, [INCIDENT_RUNBOOK.md](INCIDENT_RUNBOOK.md)). Not built.
- **Dependants:** when a screen records a parent or guardian, call `setGuardianIn` from `consent.ts` inside its own transaction.

## Known limits

- **Legal review.** All notice and email text is plain-language drafting, not legal wording, and the retention defaults are starting points.
- **No editor for notices.** `privacy_notices` can be filled by hand or by a later Settings screen; the API has no write route yet.
- **The portal sign-in account is global.** It is removed on erasure only when it opens nothing else (no other person here and no other business). Otherwise it stays, because it belongs to the person's other businesses.
- **Hashed bounce records stay.** `message_suppressions` holds salted hashes of addresses that bounced; erasure does not remove them, so a bounced address is not mailed again.
- **Other places names can hide.** Audit scrubbing covers a fixed list of metadata keys and exact full names, phones and emails. A name written in a different form (for example only a first name in a note) is not found. The activity log is meant to hold ids, not names (rule in STANDARDS.md), and new code must keep to that.
- **Customer-written notes elsewhere.** Erasure clears the places the customer's details are stored today. Tables added by later features must add themselves to `erasure.ts` and `export.ts`; the integration test scans every table with a `tenant_id` column for the customer's name, phone and email, so a new table that holds them fails the test.
- **Invoices.** There is no invoice table on this branch; payments and refunds are the retained financial records. Feature 24 must keep invoices out of erasure and add them to the export.
- **PDF** shows Western European letters only (see above).
- **Failed erasure.** If an erasure fails every retry, the outbox row goes to dead letter and the request stays `approved`; staff see it under Messages, Not sent. There is no request-level failure screen.
- **Bookings still ahead** for an erased customer stay on the calendar with no name; erasure stops their reminders (it clears `reminder_status` and removes unsent hand-off rows) but does not cancel them. Staff cancel them if the business wants that.
- **Skipped notices.** If the export or erasure email is skipped (the address bounced before, or the customer had none), the request is still marked completed; there is no separate state for "done but not told".
- **Correction** requests are tracked and decided here; the correction itself is made on the customer's record by staff.
- **Audit scrub reaches the scrub function only through the worker.** Running an erasure by hand needs the worker role.
- Consent changes made by older code paths (booking, staff) do not write consent rows until the lanes above call `recordConsent`.
- The consent trigger lets the table owner delete only inside `kalendr_erase_consent_records`, which sets a flag the table owner could also set by hand. The protection is that the app and worker roles cannot, and that every use is by someone with the owner login.
- **Not tested against real services:** no real email was sent (capture mode only), and the S3 file store was not used (disk store in tests).

## Needs your credentials: a legal review of the notice wording

> TODO FOR LEGAL REVIEW (not shown to customers): `src/server/privacy/notice.ts` (default notice, English and Hindi), the three email templates `privacy-export-ready`, `privacy-erasure-done`, `privacy-request-overdue`, the erasure summary sentences in `rules.ts`, and the retention defaults in `defaultRetention`. A lawyer must review these before launch, including the length of time medical and billing records must be kept in each state. The notice also needs the business's own details (who is responsible for the information and how to contact them), which the built-in text does not know.

Product wording rule: say "tools to help you meet your duties". Do not state or imply that the product or a business using it satisfies any law. A test fails if the product text or these two docs contain such a claim.

Nothing else in this feature needs an account. Email goes through the existing email provider (capture mode locally).

## Running the tests

`scripts/verify-postgres18.sh` runs `src/server/privacy/privacy.integration.test.ts` and `privacy-erasure.integration.test.ts` and `privacy-worker.integration.test.ts` against a disposable PostgreSQL 18. They only run with `DATABASE_URL`, `KALENDR_TEST_OWNER_URL` and `WORKER_DATABASE_URL` on an isolated local database (guard in `src/test/isolated-database.ts`) and `KALENDR_PREVIEW_MODE=false`. The pure rules, PDF and zip tests run in `pnpm test`.

Grants: `kalendr_erase_consent_records`, `kalendr_scrub_audit_personal` and `kalendr_breach_affected` are for the worker role only. They are revoked from `PUBLIC` in the migration, and the release step (`scripts/migrate.mjs`), `scripts/e2e-database.mjs` and `scripts/verify-postgres18.sh` revoke them from the web app's role after the blanket function grant. `kalendr_resolve_data_export` is for the web app's role (`scripts/local-db.sh` grants it).
