# App marketplace (feature 55)

One Apps page (Settings, Apps) for every connection a business has, and one framework so a new app gets install,
settings, delivery, retries, an activity log and removal without writing any of them.

## What is on the page

| Tab | What it holds |
| --- | --- |
| Apps | Search and category filter. **Apps that install here** (Slack, HubSpot, Google Analytics) and the **existing integrations** (Google, Outlook and Apple calendars, video visits, online payments, WhatsApp, text messages, webhooks, API keys, AI assistants, website widget, WordPress) listed with their live state and a button to the screen that already manages them. Nothing of those was copied: they keep their own credentials and rules. |
| Signed in | Approvals people gave apps through OAuth (the browser extension, apps the owner registered). Anyone can disconnect their own; people with the `apps.manage` permission can disconnect anyone's. Takes effect on the next request. |
| Your own apps | Owner only, second-factor step-up, Growth plan. Register software you built so it signs in with OAuth instead of holding a key. |

## Apps that install here

An app is a TypeScript module in `src/server/apps/catalog/` that satisfies `AppDefinition` and is listed in
`src/server/apps/registry.ts`. It declares: key, name, category, what it sends in plain words, the hosts it may call, its
credential fields and settings form (both zod), the events it listens for, and three pure functions: `build` (event to
request), `buildCheck`, `interpret` (reply to verdict), optionally `buildRevoke`. It never makes a call.

* **Install** (`POST /api/staff/apps/{key}/install`): needs `apps.manage`, the Growth plan (`api` feature), a fresh second
  factor. Credentials are validated, sealed with the business's data key (purpose `app.<key>`, re-encrypted by the key
  rotation job) and stored in `app_installs`. A check is queued; the worker makes it.
* **Delivery**: the booking fan-out (`src/worker/webhooks/fanout.ts`) also writes one `app.deliver` outbox row per
  installed, active app that listens for the event. `src/worker/apps/deliver.ts` builds the request, sends it through
  `src/server/apps/transport.ts` (https only, only the app's declared hosts, public addresses only, pinned connection, no
  redirects, 10 s), reads the reply, drops it, and writes a fixed-code row to `app_events`. Failures retry after 1 min, 5
  min, 30 min, 2 h, 6 h. A refused key switches the app off at once; 15 failures in a row switch it off too. A failing app
  never touches a booking, a message or another app.
* **Remove** (`DELETE /api/staff/apps/{key}`): the row goes to `uninstalling` and stops sending; the worker revokes the key
  at the provider when the app can (Slack `auth.revoke`), then deletes the credentials and the row. If the provider cannot
  be reached after four tries the credentials are deleted anyway and the log says `revoke_failed`.
* **Consent and data**: HubSpot sends only for customers whose latest `marketing_messages` consent is granted, only the
  fields the owner turned on, under the property names the owner chose. Slack adds a first name only if the owner turns it
  on. Google Analytics sends the service name and a hashed id, nothing about the customer.
* **Never shown or logged**: credentials are not returned by any route, not in audit metadata, not in `app_events`.

## OAuth 2 for apps

Authorization code with PKCE (S256 required), built on the API-key scopes. Nothing a token can do is new.

| Piece | Where |
| --- | --- |
| Consent screen | `/oauth/authorize` (signed-in staff only) |
| Token endpoint | `POST /api/oauth/token` (`authorization_code`, `refresh_token`), `POST /api/oauth/revoke` |
| Tokens | access `kat_` (1 hour), refresh `krt_` (60 days, rotated on every use; reuse revokes the whole approval), code `kac_` (10 minutes, once). 256 random bits; only SHA-256 hashes are stored. |
| Clients | built-in `kalendr-extension` (public, PKCE, redirect `https://<32 letters>.chromiumapp.org/…`) and apps the owner registers (secret `kcs_`, hashed, redirect addresses matched exactly) |
| Scopes | A grant gets the requested scopes, cut down to what the approving person may do themselves (`services:read` anyone, `bookings:today` needs `schedule.read`, `links:write` needs `services.manage`, others need `api.manage`). |
| Use | `Authorization: Bearer kat_…` on the public API. `getApiKeyContext` joins the approval, the person's membership and the business, so revoking, removing the person or pausing the business stops the next request. |

New scopes: `bookings:today` (today's times and first names only) and `links:write` (single-use links). `links:write` is a
write scope, so a test key cannot hold it.

## Migration

`0071_apps_marketplace`: `app_installs`, `app_events`, `oauth_clients`, `oauth_grants`, `oauth_codes`, `oauth_tokens`, all with
forced row-level security; `kalendr_resolve_oauth_token`, `_code`, `_refresh`, `_client` (ids and scopes only, for the web
app, so none is on a REVOKE list). No new worker function and no new environment variable.

## Known limits

* **Zoho CRM and Salesforce** are not built. Both need an OAuth client registered with the vendor (credentials only the
  owner can create); the framework supports them as one more module each once those exist.
* **Slack out-of-office posts**: there is no public event for time off yet, so only bookings are posted.
* **Slack channel picker**: the channel is typed (`#bookings` or an id) and proven by the check message; a picker would need a
  Slack call from a web request.
* **Google Analytics** answers 2xx to anything, so the check proves the secret is well formed, not that Google accepted it. Look
  at Realtime in Analytics.
* HubSpot and Google cannot revoke a key from our side: the page tells the owner to delete it there.
* **WordPress plugin** is tested against the embed script's contract, not on a real WordPress site (no PHP on the build
  machine), and is not listed on wordpress.org.
* A third-party directory (apps other businesses can find and install) needs a review process; today a registered app works
  only for the business that registered it.
* If someone is signed out when an app sends them to approve it, sign-in brings them back to the same approval page.
