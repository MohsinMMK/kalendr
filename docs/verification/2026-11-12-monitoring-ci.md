# Monitoring, browser tests and CI (feature 35) — 12 November 2026

Built start-up environment checks, redacted JSON logs, Sentry and OpenTelemetry (both off
unless configured), `/api/health` and `/api/ready`, Playwright journeys with an axe scan,
a CI workflow, knip and a dependency audit, one container image for the web app, worker and
release step, and `docs/OPERATIONS.md`. Everything below ran on this machine against local
PostgreSQL 18.6 containers. No test or demo reached a real outside service: email and Sentry
went to `e2e/support/capture-server.mjs`.

## "Done when", one by one

| Criterion | What was done | Result |
| --- | --- | --- |
| Missing secret stops start-up and names it | `docker run kalendr:local` with every variable but `BETTER_AUTH_SECRET` | Exit 1, `Kalendr cannot start. Fix these environment variables:` / `- BETTER_AUTH_SECRET is required in production`. With nothing set it names all four required variables. No value is printed. |
| Forced server error reaches Sentry with the request id and no personal data | Image run with `SENTRY_DSN` pointing at the capture server and the database unreachable; requested `/book/lotus-dental?phone=%2B919845012345&email=asha.check%40example.com` | 500 to the browser, with "Reference: 1195905211" on the error screen. One Sentry event, tags `request_id`, `route: GET /book/[clinicSlug]` and `error_digest: 1195905211`; the request URL has no query string; the failed query's values read `params: [redacted]`; no phone or email anywhere in the event or the container output. The same `requestId` and `errorDigest` are on the first error log line. |
| A log line with a phone number is redacted (tested) | `src/server/logger.test.ts` | 9 tests pass, including a phone in a message, contact fields, nested strings, and (added today) the values of a failed database query in messages, stacks, Sentry events and `console.error`. |
| CI runs on a pull request and blocks a merge when the double-booking test fails | `.github/workflows/ci.yml` written; jobs Checks, Browser journeys, Container image | **Not run on GitHub: no GitHub repository exists yet.** Checked locally instead: the YAML parses (3 jobs), and each step's command passed when run by hand (see "CI steps run by hand"). The GitHub-only parts (actions, the `postgres` service container, the browser cache) were not exercised, and actionlint was not run. Blocking a merge needs the owner to make the checks required (`docs/OPERATIONS.md`, "Branch protection"). |
| `/api/ready` fails when the database is down | Web container against the e2e database; `docker pause` on the database | 200 `ready` before; 503 `{"status":"not_ready","checks":{"database":"unavailable","migrations":"unavailable"}}` after about 2 s, shown in the browser. |
| The container image runs the app and the worker | `kalendr:local` (509 MB, user `node`, no `.env` inside) | Web: `/api/health` 200, `/api/ready` 200. Worker (`node dist/worker.mjs`, local capture, on the database container's network): `worker started`, a heartbeat with `pending`, `oldestPendingSeconds` and `deadLetters`, and outbox items handled, with no phone or email in its output. Release step (`node dist/migrate.mjs`): `Migrations applied in 44 ms`, exit 0. |
| A backup has been restored once, with the steps written down | `pg_dump -Fc` of the seeded e2e database, `pg_restore` into `kalendr_restore` | Dump 0.18 s (228 KB), restore 0.44 s, exit 0. Row counts identical across 36 tables, the same `kalendr_schema_version()`, forced RLS on 29 tables in both. Steps are in `docs/OPERATIONS.md`, "Restore a backup". |

## Browser journeys

`pnpm exec playwright test --project=desktop` and `--project=phone` (360 × 780), each on a
freshly seeded database: **8 passed on desktop, 8 passed on phone.**

- double-booking: two customers race for one slot; one wins, the other is told and the database holds one appointment
- isolation: one business's staff cannot read another's appointment
- monitoring: `/api/health`, `/api/ready`, and every captured error report has a request id and no contact details
- owner-setup, customer-books, customer-manages (move and cancel), and two staff-day journeys (book, check in, complete; mark a no-show)

Every screen a journey visits gets an axe scan (WCAG 2.2 AA tags). Serious and critical
findings fail the journey, except four from vendored components, which are listed in
`e2e/support/journey.ts` and under "Known limits" in `docs/PLATFORM_ROADMAP.md`.

## Found and fixed during verification

- **Query values in error reports and console output.** A failed database query's error
  message ends with its bound values (`params: …`). The Sentry event and Next.js's own
  `console.error` print both carried them, and only phone and email patterns were scrubbed,
  so a name would have gone out. `redactText` now drops the values, a new `redactError`
  keeps the error printable without them, and `startServerMonitoring` routes
  `console.error`/`console.warn` through the same redaction. Unit-tested; rechecked against
  a rebuilt image (see below).
- **No link from the error screen to the report.** The error screen shows Next.js's digest
  as "Reference", but neither Sentry nor the logs carried it, so a quoted Reference led
  nowhere. `reportRequestError` now adds it as the `error_digest` tag and the `errorDigest`
  log field, after checking its shape. The logger's phone pattern then hid the 10-digit
  digest, so `errorDigest` alone skips the pattern scan when it is a short identifier
  (anything else in that field is still scrubbed; tested).
- ESLint linted the bundled `dist/` scripts; `dist/**` is now ignored.

## Commands

```sh
pnpm check
bash scripts/verify-postgres18.sh
pnpm knip            # exit 0; 61 unused exports, 16 unused types as warnings
pnpm audit:deps      # no known vulnerabilities (high, production)
KALENDR_E2E_ADMIN_URL=… node scripts/e2e-database.mjs && pnpm exec playwright test --project=desktop
KALENDR_E2E_ADMIN_URL=… node scripts/e2e-database.mjs && pnpm exec playwright test --project=phone
docker build -t kalendr:local .
```

## Results of the final run

- `pnpm check`: exit 0. ESLint (no warnings), `tsc`, Vitest (70 test files passed, 5 skipped; 517 tests passed, 21 skipped) and `next build`.
- `bash scripts/verify-postgres18.sh`: exit 0. Migrations applied as the owner, local seed verified (3 businesses, RLS denial), 3 integration files with 16 tests passed, "PostgreSQL 18.6 migration, runtime isolation, and appointment integration acceptance passed."

### CI steps run by hand

No GitHub repository exists, so the workflow was checked on this machine:

| Job | Step | Result |
| --- | --- | --- |
| — | Workflow file | Parses as YAML; jobs `checks`, `journeys`, `image` |
| Checks | `pnpm install --frozen-lockfile` | exit 0 |
| Checks | lint, typecheck, unit tests | exit 0 (inside `pnpm check`) |
| Checks | `pnpm knip` | exit 0 |
| Checks | `pnpm audit:deps` | exit 0, no known vulnerabilities |
| Browser journeys | `bash scripts/verify-postgres18.sh` | exit 0 |
| Browser journeys | `pnpm build` | exit 0 (inside `pnpm check`) |
| Browser journeys | Playwright version | 1.65.0 |
| Browser journeys | `node scripts/e2e-database.mjs` then `pnpm exec playwright test` (both projects in one run, as CI does) | **16 passed** (8 desktop, 8 phone) in 1.3 min |
| Container image | `docker build`, `id -u` in the image, `ls dist/worker.mjs dist/migrate.mjs` | exit 0; uid 1000; both files present |

Not checked: the `uses:` actions, the `postgres` service container and the browser cache, which exist only on GitHub's runners. actionlint is not installed and was not run.

## Not tested

- CI on GitHub, and the merge block: no GitHub repository exists yet, and the owner still has to turn on branch protection once it does. actionlint was not run.
- A real Sentry project or OTLP collector. Only the local stand-in received events; tracing was not exercised.
- The worker sending real messages: it has only its local capture mode.
- `compose.yaml`'s `app`/`worker`/`migrate` services were not started with `docker compose`; the same image and commands were run with `docker run`.
- A restore of a production-sized database, or a managed provider's point-in-time restore.
