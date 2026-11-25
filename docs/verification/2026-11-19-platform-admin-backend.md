# Platform admin console, backend (feature 15) — 19 November 2026

Run on this machine against a throwaway local PostgreSQL server on 127.0.0.1:5609 with a database made by `scripts/e2e-database.mjs` (name suffix `adminbe`), as the non-owner runtime and worker roles, with real Better Auth sign-ins. PostgreSQL 18 (`scripts/verify-postgres18.sh`) was **not** run. No browser test of the console exists yet (screens are a separate change). The scratch database had one local patch to `admin_start_impersonation` (see "Migration 0042 bug" below); the integration tests need that fix in the migration.

| Done-when | Test (file: name) | Result |
| --- | --- | --- |
| A staff member who guesses `/admin` gets a 404 | `platform-admin.integration.test.ts`: "answers 404 not_found to a staff member and to someone with no session at all"; "answers 404 to a staff-only user on every /api/admin route, whatever the method" (imports every route and calls GET, POST, PUT) | Pass |
| Second factor mandatory | same file: "refuses an operator with no second factor, one who has not used it this sign-in, and one whose check is older than 12 hours"; unit `admin-context.test.ts` (11 cases incl. passkey, host and IP limits, preview, page redirects) | Pass |
| Support finds why a reminder was not delivered without seeing a name | "lets a support operator find why a reminder was not delivered, with no name or destination in the answer" (failed notification with `suppressed_bounced`: "Skipped: the address bounced earlier.", no ciphertext, no number, no name, no address in the JSON) | Pass |
| Runtime role cannot read operators or audit, or change audit events | "gives the runtime role no way to read the operator list or the audit trail, or to change an audit event" (including that the owner is refused by the append-only trigger) | Pass |
| Non-operator calling `admin_list_tenants` directly raises | "refuses the database functions to a non-operator, called directly" | Pass |
| Business A cannot see business B's support sessions | "keeps business A's support sessions out of business B's view" | Pass |
| View as a business: reason of 10 characters, write needs super, 30 minutes, expiry | `platform-impersonation.integration.test.ts`: "needs a reason of 10 characters, and write access needs the super role"; "lasts exactly 30 minutes, stores only the hash of the token…"; "gives a read-only owner view with the banner, refuses every write, and stops the moment the session ends or expires" | Pass |
| Read-only cannot save | same, plus unit `staff-write-guard.test.ts` (every write permission refused with `read_only_support_session`; every write handler under `src/app/api/staff` guarded) | Pass |
| Page views recorded; session in the business's Activity log | "records each viewed path once a minute…"; "shows the session in the business's own Activity log, with the reason, as Kalendr support and without the operator's name" | Pass |
| Pause hides the public page, staff still work | "hides the public page and stops bookings while paused, keeps staff working, and restores it on resume" | Pass |
| A new feature is switched on for one business only | "switches a new feature on for one business only when listed"; also off, all, percent 0/100/50, and the business's own switch both ways | Pass |
| Resend verification email | "queues one email per Idempotency-Key and records one action…"; "is sent by the worker with its own role, once, and dropped when already verified" (fake provider) | Pass |
| Operators managed by super only | "lets only super manage operators, by email, with a reason, and never remove oneself" | Pass |

Unit tests added: `admin-access.test.ts` (host, IP allow-list and forged forwarded entries, role matrix, cookie flags, env validation), `explain.test.ts`, `feature-layers.test.ts`, `admin-context.test.ts`, `staff-write-guard.test.ts`. Full unit run without database variables: 1526 passed, 172 skipped; the two failures were the new integration files constructing their database handle without the variable (fixed afterwards: they now skip).

## Migration 0042 bug found

`admin_start_impersonation` fails on every call with `column reference "ends_at" is ambiguous` (42702): the function returns a table with a column named `ends_at`, and its first UPDATE uses unqualified `ended_at` and `ends_at`. Fix, inside the function body:

```sql
UPDATE public.impersonation_sessions SET ended_at = now()
WHERE impersonation_sessions.admin_user_id = p_admin AND impersonation_sessions.ended_at IS NULL AND impersonation_sessions.ends_at > now();
```

## Other findings

- `staff-second-factor.integration.test.ts` currently fails 6 tests on this branch: `loadBilling` (feature 14) inserts a `Date` as a bound parameter through a raw runner, which the driver rejects. The admin tests seed a `tenant_subscriptions` row to stay independent of it.
- Not covered: a real email provider, a browser, the screens, the PostgreSQL 18 script.
