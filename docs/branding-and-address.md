# Branding and own web address (feature 13)

What it does: a business gets its look on public pages and emails (accent colour, corners, logo, cover, hide-the-badge), can serve its pages on its own address such as `book.theirbusiness.com`, and lists the websites allowed to frame its booking widget.

## Look

- Stored on `tenants.brand` (json). Read through `parseBrand` (`src/lib/brand-theme.ts`), which cleans each field alone: `accent` is a plain `#rrggbb` or nothing, `corners` is `square`, `soft` or `round`, `hideBadge` is a boolean. The logo and cover stay in `media_assets` (feature 10 storage, type, size and virus checks unchanged).
- `readAccent` picks white or black text for the accent, whichever reads better (at least 4.5 to 1 for every possible colour; the worst case is a mid-tone at about 4.58). The screen tells the owner when dark text is used on a light colour, and when a colour is so pale that thin lines in it vanish.
- `brandStyle` turns the look into the coss variables (`--primary`, `--primary-foreground`, `--ring`, `--sidebar-primary*`, `--radius`) as an inline style on the page wrapper. Applied by `BookingShell` to the business page, team and find pages, the booking flow, the manage page, the offer page and the portal visit page. Staff screens never get it.
- Emails: the worker's email adapter reads the brand and the plan, uses the accent in the layout and on buttons (with readable text) and drops "using Kalendr" when the badge is hidden and the plan allows it.
- Plan: hiding the badge needs `removeBadge`, an own address needs `customDomain` (both Growth and Scale in `planDefinitions`). The save route refuses with 402 `plan_limit` (the screen opens the upgrade dialog), and the stored flag is held to the plan on every read (`effectiveBrand`), so a lapsed plan shows the badge again without an edit.
- Invoices and the QR poster: Kalendr's own invoices (feature 14) are Kalendr's and stay unbranded. There is no QR poster in the product yet; it should call `loadPublicBrand` when it is built.

## Own web address

1. The owner types `book.theirbusiness.com` (`normaliseHostname`: lower case, punycode, a name in front of the domain, no ports or IPs, not Kalendr's own hosts).
2. Kalendr shows two records: a `CNAME` from the address to `KALENDR_CNAME_TARGET`, and a `TXT` at `_kalendr-verify.<address>` with `kalendr-verify=<token>`. The TXT sits on its own name because a name with a CNAME cannot hold another record. The token is 256 random bits shown once; only its SHA-256 is stored (`verification_token_hash`). "Show the records again" makes a new token.
3. "Check now" writes a `domain.check` outbox row and returns 202; the worker looks the records up with `node:dns/promises` (timeout 4 s per lookup) and the screen reads the list again every few seconds. The timed job `domain-sweep` (every 5 minutes) rechecks a pending address for 72 hours (`check_until`), then marks it `failed` and emails the owner.
4. Both records found: `status = active`, `verified_at` set. A failed lookup (timeout, DNS outage) is never read as a missing record.
5. A live address is rechecked daily. If the records vanish, `missing_since` is set, the owner is emailed once, and the address keeps serving for 7 days; after that it is `failed` and the owner is emailed again. `kalendr_domain_lookup` applies the 7 days itself, so the address stops at that moment even if the worker is down.
6. A pending claim that never verified (failed, or past its 72 hours) does not block the rightful owner: `kalendr_claim_hostname` clears such rows before it inserts. A live address can never be taken.

Per business: up to 3 addresses. All writes need `settings.manage`, the read-only support guard, and a plan with `customDomain`. Audit rows carry only the host.

### Request routing (`src/proxy.ts`)

- Host routing is on only when `KALENDR_CNAME_TARGET` is set; without it every host is Kalendr's own. `/api/health` and `/api/ready` answer on any host (load balancers probe by IP address or service name). When it is on, any other name staff or customers use to reach the app (a second domain, an internal service name) must be in `KALENDR_OWN_HOSTS`, or it gets the plain 404.
- Kalendr's own hosts are `localhost`, `127.0.0.1`, `[::1]`, the host of `NEXT_PUBLIC_APP_URL` and `BETTER_AUTH_URL`, `KALENDR_CNAME_TARGET`, and anything in `KALENDR_OWN_HOSTS`. Everything else is looked up through `kalendr_domain_lookup` (cached 60 s for a hit, 15 s for a miss, bounded to 500 entries, on its own 2-connection pool). Unknown hosts get a plain 404 (503 when the database cannot be reached). Staff sign-in and staff screens exist on Kalendr's own hosts only.
- On a business's address `/` shows the business page, `/book/...` the booking flow, and `manage`, `pay`, `portal`, `offer`, `q`, `check-in`, `visit`, `m` and `class` pass through. `/b/<other>` and every other path is a 404. Of the API only `/api/public/` and `/api/portal/` pass; `/api/staff`, `/api/auth`, `/api/admin`, `/api/internal`, `/api/v1` and `/api/webhooks` are refused. The CSP is computed from the page that renders, not the address typed.
- Prefetches on Kalendr's own address are passed straight through as before. Next 16 runs the proxy on the Node.js runtime, which is why it can use the database client.

### Certificates

The host in front of Kalendr issues certificates on demand and must ask `GET /api/internal/domain-check?domain=<host>` first (Caddy: `on_demand_tls { ask https://app.example/api/internal/domain-check?token=... }`). The answer is 200 only for a live address and 404 for anything else, with no body. `KALENDR_DOMAIN_CHECK_TOKEN`, when set, must be sent as `token=` (compared in constant time). The route is rate limited (`domain_check.ip`).

## Embedding

`tenant_embed_origins` holds the sites allowed to frame a business's booking page, written through `new URL(...).origin`, https only, checked again by a database constraint and when the header is built. The proxy reads them per business (cached 60 s) and builds `frame-ancestors 'self' <operator list> <saved sites>` for `/book/<slug>`, on Kalendr's address and on the business's own address. `KALENDR_BOOKING_FRAME_ANCESTORS` stays as an operator list that is always allowed (for Kalendr's own demo pages). Settings > Website connection saves the website when the owner copies the inline or popup code, and lists and removes allowed sites.

## Schema (migration `0055_branding_domains`)

`tenants.brand`; `tenant_domains` gains `last_checked_at`, `last_result`, `check_until`, `missing_since`; new `tenant_embed_origins` (forced row-level security, shape constraint). Functions: `kalendr_domain_lookup(host)`, `kalendr_embed_origins(slug)` and `kalendr_claim_hostname(...)` (runtime role, return a slug, origins or an id), `kalendr_domain_tenants()` (worker only, revoked from the web role in the three REVOKE lists).

## Known limits

- The hostname rule needs a name in front of the domain (`book.example.com`), so an apex domain (`example.com`) cannot be connected. Public-suffix domains such as `shop.co.uk` pass the three-label rule even though the registrable domain is two labels; the CNAME works there.
- A proxy cache can serve a refusal for up to 15 seconds after an address goes live, and a removed address for up to 60 seconds, on a server other than the one that handled the change.
- The domain-check answer follows the same live rule as the proxy. A certificate that was issued before an address was removed stays valid until it expires; the host should stop renewing once `domain-check` answers 404.
- Portal and manage pages on a business's own address use that address's cookies, so a customer signs in again there.
- The "live" step is proved in the browser tests by writing the row the worker writes; the worker's lookups are proved with a fake resolver. Neither touches real DNS or a real certificate authority.
