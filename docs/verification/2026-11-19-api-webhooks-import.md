# Public API and webhooks (34), data import (12), verification note

Date: 19 November 2026. Built against a local capture transport; no real receiver, email provider or customer was contacted.

## What was run

- `pnpm check` (lint, typecheck, all unit and component tests, production build): passed.
- Database tests on a throwaway PostgreSQL **17.11** (the sandbox had no Docker, so not 18) with the non-owner roles: `api-v1`, `api-keys-admin`, `webhooks`, `imports`, `imports-bookings`, plus the existing outbox and appointment repository files: passed. Add them to `scripts/verify-postgres18.sh` (done) and run there before release.
- Playwright on desktop and phone (`e2e/developers-keys.spec.ts`, `e2e/import-wizard.spec.ts`), against a production build, the throwaway database and a real worker, with an accessibility scan at each step: passed. Screens were also looked at in screenshots at phone width.

## Done when: feature 34

| Done-when | Result |
| --- | --- |
| A script with a key lists availability and books an appointment that shows on the schedule and in the audit trail as that key | Passed (`api-v1.integration.test.ts`; audit actor_type `api_key`) |
| A key without `appointments:write` is refused | Passed (403 `insufficient_scope`; test keys are read-only) |
| A receiver gets a signed `appointment.created` and verifies it with the documented code | Passed (`webhooks.integration.test.ts`, fake transport, `verifyWebhookSignature`) |
| A failing endpoint is retried then disabled | Passed (8 attempts on the schedule, disabled after 12 straight failures, owner email queued) |
| `http://127.0.0.1` and other private addresses are refused | Passed at save time and at connect time; redirects are never followed |
| The docs page lists every route in the generated spec | Passed (`/developers`; a test fails if a route and the spec disagree) |

## Done when: feature 12

| Done-when | Result |
| --- | --- |
| 2,000 messy rows with 50 duplicates import quickly with matching totals | Passed (1,900 ready, 60 skipped, 40 errors; a few seconds) |
| The 50 duplicates are skipped; the error file holds exactly the bad rows | Passed |
| Undo removes imported customers and leaves earlier ones | Passed (also keeps ones used since) |

## Known limits

- `payment.captured` is defined but nothing fires it yet: the payments lane must call `queuePaymentCaptured`.
- Webhook secrets are not yet in the key re-encryption job (retired keys still open).
- Plan-based API limits wait for feature 14. Customers created inside a booking get `customer.created` in a follow-up transaction.
- The worker bundle script (`pnpm build:jobs`) fails on `web-push` on this branch with or without these changes.
- Imported services are active and listed, assigned to all locations and staff.
