# Privacy centre (feature 7) — 19 November 2026

Run on this machine: PostgreSQL 17 (Docker was off, so `scripts/verify-postgres18.sh` was **not** run), a production build on `localhost:3100`, the capture server for email, the local worker (`pnpm worker:local`).

| Done-when | Evidence | Result |
| --- | --- | --- |
| A customer downloads their data from the portal | Browser: the portal asks for the download and an outbox row is queued; local worker run: `data_requests` export rows `completed`, `data_exports` rows created. Integration tests: the zip holds profile, bookings, payments and a PDF; the link works once and expires after 7 days; a retry after a failed email works | Pass (the emailed link was exercised by the integration test, not clicked in a browser) |
| A customer withdraws marketing and is excluded from the next campaign while still getting reminders | Browser: marketing switch on then off writes two `consent_records`; appointment messages stay on. Integration: `canSendMarketing` false while reminders pass, web and worker versions | Pass for the gate. **No campaign exists yet** (feature 28/lane A): it must call `canSendMarketing` |
| An approved erasure removes name and phone everywhere except the retained invoice; the audit trail shows who approved | Browser: staff approve with a fresh code (step-up), audit row `privacy.request.approved` has the approver; local worker run: erasures `completed`, patients `erased_at` set. Integration: a scan of every tenant table finds no name, phone or email left; the retained row is `payments` (no invoices on this branch); no audit row lost, personal fields in old rows replaced | Pass |
| The retention job deletes expired sign-in codes and reports the count | Integration test | Pass |
| Append-only consent, tenant isolation, double submit, under-18 | Integration tests (`src/server/privacy/*.integration.test.ts`) | Pass |

Not done or not tested: the legal review of every customer-facing text; STOP keywords on WhatsApp and SMS (lane A calls `withdrawConsent`); the consent notice on the public booking page (lane C; `GET /api/public/privacy-notice` and `PrivacyNoticeLink` are ready); the admin-console breach action (feature 15); businesses cannot edit their notice text yet; Hindi notice switch not clicked in a browser.
