# Staff sign-in options and second factor (feature 6)

Built 19 November 2026 on `better-auth` 1.7.21 and `@better-auth/passkey` 1.7.21. Nothing here uses custom cryptography: the authenticator-app codes, backup codes, passkeys and one-time links all come from Better Auth's own plugins.

## What a person can do

| Way in | How it works | Needs |
| --- | --- | --- |
| Password | As before. A person with an authenticator app is asked for a code on the same screen. | Nothing new |
| Continue with Google or Microsoft | Better Auth's social sign-in, with sign-up switched off for each provider. | An OAuth app per provider (see below) |
| Email me a sign-in link | One-time link emailed through feature 2, valid 10 minutes, token stored hashed, works on any device. | Email delivery |
| Passkey | Fingerprint, face or device PIN. User verification is required, so one passkey counts as both factors. | An HTTPS address in production |

**Social sign-in never creates access.** `disableImplicitSignUp` is on for Google and Microsoft, `databaseHooks.user.create.before` refuses any user Better Auth would create itself, and `databaseHooks.session.create.before` refuses a session for anyone without an active membership, whatever way they proved who they are. An invite already creates the user and the membership, so an invited receptionist's first Google sign-in links to that user and works; a stranger sees "Ask your manager to invite you." and no `auth_users` row is written. The provider must say the email is verified (no provider is listed as "trusted"), and `requireLocalEmailVerified` is off because an invited person's own email is not verified yet. The first time an invited person signs in this way, the unknown placeholder password that came with the invite is removed. Signing up a new business with Google or Microsoft on `/start` is separate: that leg only proves the email (`src/server/sign-up-oauth.ts`), `registerClinic` makes the user and the membership together, and only then does the page sign in through Better Auth ([onboarding.md](onboarding.md)).

## Sign-in page

`/sign-in` is for people who already have an account: one centred coss Frame on a faint dot-grid background, with a "Get started" link to `/start`. The method used last (password, link, passkey, Google, Microsoft or company account) is kept in `localStorage` (`kalendr:last-sign-in-method`) and marked "Last used" on the next visit. Browser autofill no longer tints inputs yellow (`globals.css`).

## Second factor

- Owners and admins must have a second factor; a business can ask everyone (`tenants.security_policy`, `requireSecondFactorForAll`, changed under Profile, Security with a fresh code).
- Better Auth's plugin only challenges *password* sign-ins. Google, Microsoft, link and passkey-only sessions would skip it, so the check is on the session: `auth_sessions.second_factor_at` is set when a code, a backup code or a passkey is verified, and `getStaffContext` reads it on every request:
  - no factor and the role needs one: `403 second_factor_required` (pages redirect to `/security/second-factor`);
  - a factor exists but this sign-in has not used it: `403 second_factor_pending` (pages redirect to `/sign-in/verify`).
- Step-up: `requireRecentStepUp(context)` (beside `requirePermission`) throws `403 step_up_required` unless the session passed a second factor in the last 10 minutes. Wired into: changing a teammate's role or permissions, changing the business security policy. Features that add payment settings, API keys, data export (feature 7) and customer deletion call it too.
- Removing the authenticator app, changing a password, or choosing "Sign out everywhere" ends the other devices' sessions. Sessions are looked up in the database on every request (no session cookie cache), so a removed device is refused at once.
- Every sign-in, failed sign-in, factor change, passkey change and device removal writes `audit_events` in each business the person works in (`staff.sign_in`, `staff.second_factor.*`, `staff.passkey.*`, `staff.device.removed`, ...). Metadata holds a short method word only.
- The person is emailed when a browser they have not used before signs in, and when a factor, a passkey or the password changes.

## Tables and migration

`0038_staff_second_factor`: `auth_two_factors`, `auth_passkeys`, `auth_known_devices` (new, global like the other auth tables), `auth_users.two_factor_enabled`, `auth_sessions.second_factor_at`, `tenants.security_policy`.

## Settings

| Variable | Meaning |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Turns Google on (both or neither) |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` | Turns Microsoft on; tenant is `common` or one directory id |
| `KALENDR_DEV_OAUTH` | `true` swaps in a built-in stand-in for both providers so the buttons work without keys. It only runs when the app's own address is on this machine; startup refuses it on a public address. |

Without keys and without the stand-in the two buttons are simply not shown.

## Needs your credentials

1. **Google Cloud**: a project with an OAuth consent screen (scopes `openid email profile`) and a Web OAuth client. Redirect URI `https://<your-domain>/api/auth/callback/google`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
2. **Microsoft Entra**: an app registration (accounts in any organisational directory, or one directory), redirect URI `https://<your-domain>/api/auth/callback/microsoft`, a client secret. Add the optional `email` and `email_verified` ID-token claims; without a verified-email claim Microsoft sign-in is refused on purpose. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`.
3. An HTTPS domain for passkeys (the relying-party id is its hostname; `localhost` works for development).

None of this was done against the real providers: the real Google and Microsoft sign-ins are untested until these exist.

## Known limits

- The new-device and security-change notices are sent from the request (best effort, never blocking), like the existing password-reset emails, not through the outbox.
- "Place" in the device list is a masked network address, not a city: there is no geo-IP lookup.
- Trusted-device ("remember this browser for 30 days") is not offered: every sign-in asks again.
- The email-code fallback for the second factor is not enabled.
- Step-up is wired only into actions that exist on this branch (team roles and permissions, the security policy). Payment settings, API keys, data export and customer deletion are other features; they must call `requireRecentStepUp`.
- Passkey sign-in is tested with a virtual authenticator in Chromium; a real phone is not tested.
- Journal timestamps: `0025_visit_fields` carries a `when` later than the migrations after it, so on a database that already ran it drizzle skips newer migrations whose `when` is lower. `0038` and `0039` were given later `when` values to be safe.
