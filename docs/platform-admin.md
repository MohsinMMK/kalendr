# Platform admin console (feature 15)

The console is how Kalendr's own team answers "why did this customer not get a reminder?", pauses an abusive business, releases a feature to one business first, and looks at a customer's workspace when a customer asks for help. It never shows a customer's name, contact details, a message body or a record's content, except through "View as this business", which is bounded and logged.

This file covers the server side (the part that exists in `src/server/admin*`, `src/app/api/admin/*` and migration `0048_platform_admin.sql`). The screens are in `src/app/admin/*`.

## Roles

| Role | Can |
| --- | --- |
| `support` | Businesses, one business's health, find a message, worker and dead letters (with retry), abuse overview, pause or resume a business, resend a verification email, "View as this business" read-only, audit trail |
| `billing` | Read-only on businesses, worker and abuse, and the audit trail. Billing actions (extend a trial, change a plan) are added by feature 14: call `requireAdminCapability` with a new capability in `src/lib/admin-access.ts` and a definer function that starts with `kalendr_admin_require(user, ARRAY['billing','super'])` |
| `super` | Everything, plus write access in "View as this business", feature rollouts and the operator list |

The role is checked twice: in the route (`requireAdminCapability`) and inside every `admin_*` database function (`kalendr_admin_require`). The database is the real gate.

## Making the first operator

Operators are ordinary Kalendr users listed in `platform_admins`. The person must already have an account (an invite creates one) and must have an authenticator app or passkey.

```bash
KALENDR_SEED_DATABASE_URL=<schema owner connection> node scripts/make-platform-admin.mjs person@example.com super
```

The second argument is `support`, `billing` or `super` (default `super`). The script uses the owner connection because the runtime role cannot write `platform_admins`; it prints no address. After that a super operator adds and changes operators in the console (`/api/admin/operators`, needs a code from the last 10 minutes and a reason).

An operator with no business of their own can sign in (they have a session but no business data: `getStaffContext` still refuses them without a membership).

## Environment

| Variable | Effect |
| --- | --- |
| `KALENDR_ADMIN_HOST` | When set (host only, for example `admin.kalendr.example`), `/admin` and `/api/admin` answer 404 on any other `Host` |
| `KALENDR_ADMIN_IP_ALLOWLIST` | Comma-separated IPs. When set, every other address gets 404. The client address is read from `X-Forwarded-For` counting `TRUSTED_PROXY_HOPS` from the right (the first entry can be forged by the client), with `X-Real-IP` as the fallback when there is no forwarded header |

Both are optional and validated at startup. The second-factor rule has no switch. The console does not exist in preview mode (404).

## Security model

- **Refusals look like nothing.** Everyone who is not a working operator (staff, a visitor, wrong host or IP, preview mode) gets `404 not_found`, the same as a missing page. Only an operator who still owes a second factor sees `403 second_factor_required` or `second_factor_pending`. A visitor with no session at all is sent to sign-in by the page layer (`requireAdminPageContext`).
- **Second factor, no exception.** The user must have an authenticator app or a passkey and `session.secondFactorAt` must be set and no older than 12 hours. Impersonation with write, rollout changes and operator changes also need a check from the last 10 minutes (`requireAdminStepUp`, the same step-up the staff app uses).
- **Separate contexts.** `getAdminContext` and `getStaffContext` do not accept each other's sessions: an operator without a membership gets 403 on every staff route (unless viewing as a business, below) and a staff-only user gets 404 on every `/api/admin` route (tested).
- **Cross-business data** comes only from `SECURITY DEFINER` functions named `admin_*`, each taking the caller's user id first and refusing unless that user is an active operator with a suitable role. The runtime role has no BYPASSRLS; `platform_admins` and `platform_audit_events` have forced row-level security with no policy, so the runtime role reads and changes nothing in them directly. `platform_audit_events` is append-only (a trigger refuses update and delete, even for the owner).
- **No content.** Message search returns statuses, codes, counts and times. The one-sentence `explanation` is built from status, failure code and attempt count only (`src/server/admin/explain.ts`). Logs carry ids and the request id.
- **Every change has a reason** (zod, at least 5 characters, 10 for impersonation) and is recorded in `platform_audit_events`.

## "View as this business"

`POST /api/admin/tenants/{id}/impersonate` with `{ reason, write }` (reason at least 10 characters). Support may ask for read-only; only super may ask for write, and only with a fresh code.

- A 256-bit random token is made by the app; only its SHA-256 is stored. It travels in the cookie `kalendr_support_session` (HttpOnly, SameSite=Strict, Secure in production, Path `/`, Max-Age 1800). The session ends at 30 minutes; the database caps the window and nothing extends it.
- `getStaffContext` returns a context for that business with role `owner` only when: the cookie resolves to a live session of this operator, the operator is `support` or `super`, and their second factor is fresh. Otherwise the cookie is ignored (an expired session stops working at once; the operator is then treated as the plain, membership-less user they are).
- **Read-only** sessions carry only `records.view`, `schedule.read` and `audit.view`. `requirePermission` refuses every other permission with `403 read_only_support_session`, and every staff write route also calls `assertNotReadOnlyImpersonation` (a test lists all `src/app/api/staff/**/route.ts` write handlers and fails on any without a guard). **Write** sessions carry the owner set minus `team.manage` and `privacy.manage`.
- The context's `userName` is "Kalendr support" and its email is a placeholder, so no operator detail lands on the business's rows.
- `/api/staff/me` (GET) returns `{ role, clinicName, impersonation }` where `impersonation` is `{ sessionId, endsAt, writeAccess, businessName }` or null, for the banner.
- Each viewed page or API call is recorded through `admin_record_impersonation_view`: path only (the page's `x-pathname`, set in `src/proxy.ts`, or `via <referring page>` for API calls), at most once a minute per path, never blocking.
- The business sees the session in its own Activity log: "Kalendr support started a session (read-only)" with the reason, and "ended a session", as actor "Kalendr support". Anything an operator changes while viewing as the business shows the same actor, never the operator's name. The activity entries carry `support: true` for these rows.

## Pause

`POST /api/admin/tenants/{id}/pause` `{ paused, reason }`. A paused business has no public page (`/b/…`, `/book/…` show "This page is not taking bookings right now."), no public availability, holds, email codes or bookings (`409 business_paused`). Its staff sign in and work as usual. The business's own Activity log shows "Kalendr support paused the online booking page".

## Feature rollout

`feature_rollouts` holds one row per feature key: `off`, `listed` (tenant ids), `percent` (stable hash of key and business id) or `all`. Use `featureEnabledFor(tenantId, key, tenantFeatures?)` from `src/server/feature-rollout.ts`: the business's own explicit boolean in `tenants.features` wins when present, otherwise the rollout decides (`kalendr_rollout_enabled`).

## Resend verification email

`POST /api/admin/tenants/{id}/resend-verification` (requires `Idempotency-Key`). Records the action, then queues an outbox event `account.verification.resend` (payload: the owner's user id only). The worker handler (`src/worker/handlers/verification-resend.ts`) reads the address with its own database role, builds the same signed link Better Auth uses (valid one hour), and sends it with the configured email provider. It is dropped if the owner has verified in the meantime or the address is suppressed. The Idempotency-Key is the outbox dedupe key, so a double click sends one email.

## Known limits

- Plan, status and usage in the businesses list and health are empty until feature 14 fills them (extension points in `src/server/admin/tenants.ts`).
- "View as this business" does not load the business's plan limits: an operator with write access is not stopped by plan limits.
- Page views from API calls are recorded as "via" the page that made them, not as individual endpoints.
- Public queue, portal and visit links of a paused business are not blocked; only the booking page, availability, holds, email codes and bookings are.
- No browser test of the console exists in this backend change; the screens agent adds those. The PostgreSQL 18 script was not run.
