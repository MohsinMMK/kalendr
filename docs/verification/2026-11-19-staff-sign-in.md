# Staff sign-in options and second factor (feature 6) — 19 November 2026

Everything ran on this machine against a local PostgreSQL 17 server (Docker was not running, so the PostgreSQL 18.6 acceptance script `scripts/verify-postgres18.sh` was **not** run), a production build on `localhost:3100`, and the capture server in place of email. Google and Microsoft used the built-in stand-in (`KALENDR_DEV_OAUTH`), not the real providers.

| Done-when | How it was checked | Result |
| --- | --- | --- |
| An invited receptionist signs in with Google on first use | `e2e/staff-sign-in.spec.ts` (desktop and phone): stand-in Google page, lands on the dashboard, `google` account linked, email marked verified, the invite's placeholder password removed | Pass |
| A stranger with a Google account is refused and no user row is created | Same spec: "Ask your manager to invite you.", `auth_users` row count unchanged (Google and Microsoft); also when the provider does not vouch for the email | Pass |
| An owner without a second factor is taken to enrolment before seeing any data | Spec: a new owner signs in, is redirected to `/security/second-factor`, enrols an authenticator app through the screens, reaches the workspace, and answers the code step next time. `staff-second-factor.integration.test.ts` checks `getStaffContext` refuses with `second_factor_required` | Pass |
| A passkey sign-in works on a phone | Spec with a Chromium virtual authenticator (desktop only): add a passkey on the enrolment screen, sign out, "Sign in with a passkey". A real phone was **not** tested | Pass (virtual authenticator) |
| Removing a device ends its session at once | Spec (two browsers) and the integration test: the removed device is refused on its next request | Pass |
| Opening payment settings after 10 minutes asks for a code | No payment settings exist on this branch. Step-up is wired to the security policy and to team role and permission changes; the Spec back-dates `second_factor_at` by 11 minutes and the dialog asks for a code. The unit and integration tests cover the 9 and 11 minute edges | Pass for what exists; payment settings must call `requireRecentStepUp` when built |
| Email link: one time, 10 minutes, another device | Spec: link opened in a second browser signs in; a second use fails; an unknown address gets the same answer and no user | Pass |

Existing browser journeys (`staff-day`, `staff-schedule`) still pass: the shared `signIn` helper enrols or answers the code step for the seeded owner.

Not covered: the real Google and Microsoft providers; a real phone passkey; the new-device and security-change emails were not read in a test; the PostgreSQL 18 script.

Known test-environment note: the browser suite signs in as the same owner many times, and Kalendr limits password sign-ins to 10 per email per 15 minutes (feature 9). A full two-project run in one 15-minute window can therefore hit that limit in journeys other than these; re-running with a fresh database (`scripts/e2e-database.mjs`) clears it. `customer-books` and `owner-setup` also showed serious accessibility findings (details step, opening hours) that are in screens this feature did not touch.
