# Browser extension (feature 57)

A Manifest V3 toolbar button for Chrome and Edge. It lists the business's services with **Copy link**, a menu with **Copy
times for an email** and **New single-use link**, and a **Today** tab with each booking's time and first name. It lives in
`integrations/browser-extension/` as a pnpm workspace package built with Vite. React, zod and the types come from versions
already in the repository.

## Permissions

`storage`, and permission to call **one address**: the Kalendr site it was built for. No content scripts, no tabs, no cookies, no
identity, no page access. `src/manifest.test.ts` holds the manifest to exactly that and scans the source for anything wider.
The address is fixed at build time (`KALENDR_ORIGIN`), baked into the code and the only host permission.

## How it signs in

No password is ever typed into the extension. It uses OAuth 2 device sign-in (RFC 8628):

1. **Connect** asks Kalendr for a code (`POST /api/oauth/device`) and shows eight letters such as `BCDF-GHJK`.
2. The person opens Kalendr (a link in the popup), types or confirms the code, sees exactly what the extension may do and
   presses **Allow** (`/oauth/device`, `POST /api/staff/oauth/device`). If they are signed out, sign-in returns them to this page.
3. The popup collects the tokens (`POST /api/oauth/token`, device grant). The access token lasts an hour, the refresh token
   60 days and is swapped each time it is used.
4. Alternatively the person pastes an API key made under Settings, Developers; the extension checks it before keeping it.

What the grant can do is cut down to what the approving person could do themselves: `services:read` (services and open
times), `bookings:today` (today's times and first names only, no phone or email) and `links:write` (single-use links, needs
the permission to manage links). It cannot read customers or appointments through the full API (tested).

**Revoking.** Settings, Apps, Signed in lists the connection; **Disconnect** ends it on the next request. **Disconnect this
browser** in the popup forgets the token and tells Kalendr to revoke it. An API key is revoked under Developers. A refused
token signs the popup out and sends it back to Connect.

**Why a background worker.** Refresh tokens rotate; a popup that closes mid-swap would lose the new one. The worker
(`src/background.ts`) is the only place that calls Kalendr and holds a token, so a swap always completes and two requests
never swap twice. The popup talks to it with validated messages (`src/lib/messages.ts`).

## Routes it uses

`GET /api/ext/me`, `/api/ext/services`, `/api/ext/today`, `/api/ext/email-times?serviceId=…` and
`POST /api/ext/single-use-links`, each behind one narrow scope (`src/server/extension-api.ts`), plus the OAuth endpoints.
Special links come from feature 45 and the email snippet from feature 52; nothing is duplicated.

## Build, try and ship

```bash
pnpm build:extension                                     # check build for http://localhost:3000, also run by pnpm check
KALENDR_ORIGIN=https://your.kalendr.address pnpm build:extension
pnpm --filter @kalendr/browser-extension package         # dist/kalendr-extension-<version>.zip, refuses a localhost build
```

To try it unpacked: build it for the address you run Kalendr at, open `chrome://extensions` (or `edge://extensions`), turn on
Developer mode, **Load unpacked**, choose `integrations/browser-extension/dist`. Pin it, press Connect.

## Store listing (for the owner to submit)

* **Name:** Kalendr
* **Summary (132 characters):** Copy your Kalendr booking links, share open times in an email, and see today's bookings from the toolbar.
* **Description:** Kalendr is the appointment system for your business. This extension puts it one click away. Copy the booking link
  for any service and paste it into Gmail, WhatsApp Web or LinkedIn. Copy the next open times as a ready-to-send block with
  links that open booking at that time. Make a single-use link for one customer. See today's bookings with times and first names.
  It connects with a short code that you approve in your own Kalendr, so it never sees your password. It reads nothing from
  the pages you visit.
* **Single purpose:** Show a business's Kalendr booking links and today's bookings, and copy them.
* **Permission justification:** `storage` keeps the sign-in on this browser. The one site permission lets the popup talk to your
  Kalendr address. Nothing else is requested.
* **Data use:** the extension stores a sign-in token on the device; it sends nothing to anyone but the Kalendr address.
* **Privacy policy URL:** needs the owner's.
* **Images needed:** one 128 px icon (included), at least one 1280×800 screenshot, a 440×280 small promo tile.

## Known limits

* **Not published.** Submitting to the Chrome Web Store and Edge Add-ons needs the owner's developer accounts and the production
  address (see the report's list). The package script and listing text are ready.
* **Firefox** is not built: its Manifest V3 needs `browser_specific_settings` and a different background declaration. The code
  uses no Chrome-only API beyond `chrome.storage` and `chrome.runtime`, so it is a small follow-up.
* **One address per build.** A business on its own web address needs a build for it (or a later runtime permission request).
* **The popup closes when you click away** (browser behaviour), so connecting continues only while it is open; reopening picks up
  the same code until it runs out in ten minutes.
* Tested with unit tests of the client, messages and popup, and against the real OAuth and API routes. It has not been loaded into
  a real Chrome or Edge in this build environment.
