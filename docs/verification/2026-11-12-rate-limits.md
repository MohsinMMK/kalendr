# Rate limits and bot protection (feature 9) — 12 November 2026

Replaced the in-memory sign-up limiter with request limits kept in PostgreSQL
(`rate_limit_buckets`, one row per hashed key per fixed window, one
`INSERT … ON CONFLICT … RETURNING` per request), so every app server shares one count and
counts survive restarts. Every limit is in `src/server/rate-limit-rules.ts`. A refused
request gets 429 with `Retry-After`. Public booking also has a hidden field and a minimum
fill time, and Cloudflare Turnstile is asked for only when a request looks risky (a second
attempt from one network, from someone not signed in). The client address comes from
`X-Forwarded-For` using `TRUSTED_PROXY_HOPS`, which production now requires.

Everything below ran on this machine against local PostgreSQL 18.6 containers. Turnstile
used Cloudflare's published test keys only (site `1x00000000000000000000AA`, secret
`1x0000000000000000000000000000000AA`, which pass every token). No account was created and
no paid service was called; email went to `e2e/support/capture-server.mjs`.

## "Done when", one by one

The demo ran the production build (`next start`, `NODE_ENV=production`,
`TRUSTED_PROXY_HOPS=1`, Turnstile test keys) twice, on ports 3009 and 3010, against one
throwaway PostgreSQL 18.6 container on port 5609, seeded with the sample businesses.
Requests set `X-Forwarded-For` to documentation addresses (198.51.100.0/24).

| Criterion | What was done | Result |
| --- | --- | --- |
| Sixth registration in 15 minutes is refused, and still refused after a restart | Registrations from 198.51.100.7: attempts 1–3 to :3009, 4–6 to :3010. Both servers then stopped and started again; attempt 7 to :3009, attempt 8 to :3010 | 1–5: 201. 6: 429 `rate_limited`, `Retry-After: 429`. After the restart, 7 and 8: 429, `Retry-After: 413`. Attempts 2–5 were risky, so they carried a Turnstile token, which the server checked with Cloudflare's test secret. |
| Two app servers share one count | Same run: the count went 1–3 on :3009 and carried on 4–6 on :3010 | `rate_limit_buckets` held one row for that window, count 8, keyed by a 64-character HMAC hash; no address in the table. Also covered by `rate-limit.integration.test.ts` ("shares one count between two app servers and keeps it after a restart"). |
| 100 scripted booking posts are stopped after 10 | `node bookings.mjs`: 100 `POST /api/public/appointments` from 198.51.100.50, alternating :3009 and :3010, each a different slot and contact, with a fill time and a token | Posts 1–10 reached the booking code (6 booked, 4 lost a slot already taken: 409 `slot_unavailable`). Posts 11–100: 429 `rate_limited`, `Retry-After: 2007`. Each refusal logged `{"event":"rate_limit.refused","rule":"booking.ip"}`, with no address or contact. |
| A customer on a phone books without a challenge | Built-in browser at 375 × 812 on `:3009/book/lotus-dental`: Dental consultation, Dr Arjun Shah, Fri 20 Nov 9:00 am, a test customer | "You're booked", `POST` 201. No Turnstile field on the page. The hidden field is `aria-hidden`, `tabIndex -1` and off-screen. |
| A repeat attempt without the check is asked for it | Two booking posts from a new address, 198.51.100.70, no token | First: 201. Second: 400 `challenge_required`, with the field error under `turnstileToken`. |
| New unit and database tests | See "Tests" | All pass. |
| `pnpm check` | Lint, types, unit tests, production build | Pass: 74 files, 545 tests passed (26 skipped, the database files). |
| `scripts/verify-postgres18.sh` | Migrations 0000–0015 on PostgreSQL 18.6, seed check, four database test files | Pass: 21 tests, including the 5 new rate-limit tests. |
| `scripts/e2e.sh` | Every journey, desktop and phone | Pass: see "Browser journeys". |

## Tests

- `src/server/rate-limit.test.ts` (10): fixed windows, key hashing, client address with
  0, 1 and 2 trusted hops, spoofed left-hand entries ignored, IPv6 counted per /64, the
  in-memory fallback and its cleanup, every planned limit in the rules file, and the refusal
  log carrying the rule name only.
- `src/server/public-limits.test.ts` (5): sixth sign-up refused with `Retry-After`; booking
  posts stopped after ten; more than five bookings an hour for one phone refused from any
  network; hidden field and too-fast form refused without saying why; repeat booking asked
  for the check when Turnstile is on.
- `src/server/turnstile.test.ts` (8): no check on a first attempt, for signed-in people, or
  when Turnstile is off; missing, failed and unreachable checks.
- `src/lib/security-headers.test.ts` (2): Turnstile's script and frame sources in the CSP,
  with the nonce.
- `src/server/env.test.ts`: production refuses to start without `TRUSTED_PROXY_HOPS`, and
  with only one of the two Turnstile keys.
- `src/features/booking/booking-flow.test.tsx`: the check appears only after the server
  asks for it (the first post carries no token), and the details typed so far are kept.
- `src/server/rate-limit.integration.test.ts` (5, PostgreSQL 18): shared count across two
  servers and a restart; 40 hits at once through two connections lose no count and allow exactly 10; a hash is stored, not the address,
  and the next window starts at 1; nightly cleanup deletes only ended windows.

## Browser journeys

`KALENDR_E2E_PORT=5547 KALENDR_E2E_SKIP_BUILD=1 scripts/e2e.sh` (the production build from
`pnpm check`). Port 5547 because the usual 5546 was held by another session's container,
which was left alone. **8 passed on desktop, 8 passed on phone.**

The Playwright projects now send a fixed `X-Forwarded-For` each (192.0.2.10 and 192.0.2.20)
and the app trusts one hop, as in production, so the two projects don't share one count.

## Found and fixed during verification

- **The browser journeys booked faster than a person can.** The first run failed 10 of 16
  journeys with "We could not take this booking": Playwright fills the whole flow in under
  3 seconds, which the new minimum fill time refuses. `fillCustomerDetails` in
  `e2e/support/journey.ts` now waits the minimum before the booking is confirmed.
- **Registration is closed in production without email verification.** The demo needed
  `BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION=true` and an email sender (the capture server) to
  register at all; that rule is from earlier work and is unchanged.

## Known limits

- The refused-request counter (`kalendr.rate_limit.refused`, by rule) goes to OpenTelemetry,
  but no metrics exporter is registered yet; the JSON log line is what operators can query.
- Old rows are deleted by `deleteExpiredRateLimitBuckets()`, which nothing runs yet. It is
  marked `FEATURE 1 SCHEDULER HOOK` for the job scheduler.
- Per-business `frame-ancestors` waits for feature 13; the CSP keeps the global setting.
- A business's own server posting through the website API shares the `booking.ip` limit
  until per-key limits arrive with feature 34.
- Turnstile was tested with the always-pass test keys only; a real challenge and a real
  failure were covered by unit tests with a stubbed Cloudflare response.
- Migration `0015_rate_limits` will be renumbered at merge.
