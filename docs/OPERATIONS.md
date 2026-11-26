# Operations

How to run Kalendr in production: deploy, roll back, migrate, restore, rotate secrets, and what each alert means. Written for the person on call, who may not have written the code.

## What runs

| Part | Command in the image | Notes |
| --- | --- | --- |
| Web app | `node server.js` (the default) | Next.js standalone server on port 3000. Never runs migrations. |
| Worker | `node dist/worker.mjs` (`pnpm worker`) | Sends what the outbox queues and runs the repeating jobs (pg-boss). Run two or more; they share the queue safely. In production set `KALENDR_WORKER_MODE=production`. See [WORKER.md](WORKER.md). |
| Release step | `node dist/migrate.mjs` | Applies migrations as the owner role, then grants the runtime role and the worker role. Run it once per release, before the new web and worker start. |
| Database | Managed PostgreSQL 18 | Row-level security per business. The web app and the worker each connect as their own non-owner role. |

One image serves all three commands. Build it with `docker build -t kalendr:<git sha> .`. The image runs as the `node` user, holds no secrets, and has a health check on `/api/health`.

## Environment

Every variable is listed with a comment in `.env.example` and checked by `src/server/env.ts` when a process starts. In production the web app stops before serving anything if a required value is missing or unsafe, and the message names the variable, never its value:

```text
Kalendr cannot start. Fix these environment variables:
  - BETTER_AUTH_SECRET is required in production
```

Error reporting (`SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`) and tracing (`OTEL_EXPORTER_OTLP_ENDPOINT`) are off unless their variables are set.

`TRUSTED_PROXY_HOPS` is required in production: the number of proxies in front of the app that append the client's address to `X-Forwarded-For` (1 behind one load balancer or CDN). Too low and every visitor shares the load balancer's limit; too high and a visitor can pick their own address. The bot check (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`) is off unless both are set.

## Request limits

Every limit is in `src/server/rate-limit-rules.ts` and counted in the `rate_limit_buckets` table, so all app servers share one count and a restart does not reset it. A refused request gets 429 with `Retry-After` and logs `{"event":"rate_limit.refused","rule":"booking.ip"}` (rule names only, never an address or contact). A sudden rise in one rule is worth a look: `registration.ip` or `booking.ip` usually means a script, `code_request.contact` someone being sent codes they did not ask for. To lift a limit for one network early, delete its rows: `delete from rate_limit_buckets where window_end > now();` clears every current count (keys are hashed, so single addresses cannot be picked out). Old rows are harmless; `deleteExpiredRateLimitBuckets()` removes them and will run nightly once the job scheduler exists.

## Health checks

| Address | Answers | Use it for |
| --- | --- | --- |
| `/api/health` | 200 while the process is up. No database call. | The container or load balancer liveness check. |
| `/api/ready` | 200 when the database answers and its newest migration is the one this build expects; 503 otherwise. | The readiness check before traffic is sent, and the first check after a deploy. |

Neither reveals versions, names or internals. `/api/ready` returns only `ready` or `not_ready`, and `ok`, `unavailable`, `not_configured` or `behind` for each of `database` and `migrations`.

## One-time database provisioning

Done once per database, by a superuser or the database's admin role. Use long random passwords from your secret manager.

```sql
-- The owner runs the migrations. FORCE ROW LEVEL SECURITY applies to a table's owner too,
-- so the release step needs BYPASSRLS to backfill rows; the app and the worker never have it.
CREATE ROLE kalendr_owner LOGIN PASSWORD '…' BYPASSRLS NOSUPERUSER;     -- owns the schema; used only by the release step
CREATE ROLE kalendr_app LOGIN PASSWORD '…' NOBYPASSRLS NOSUPERUSER;     -- the web app
CREATE ROLE kalendr_worker LOGIN PASSWORD '…' NOBYPASSRLS NOSUPERUSER;  -- the outbox worker
CREATE DATABASE kalendr OWNER kalendr_owner;
\c kalendr
ALTER SCHEMA public OWNER TO kalendr_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO kalendr_app, kalendr_worker;
GRANT CONNECT ON DATABASE kalendr TO kalendr_app, kalendr_worker;
```

The roles are used like this:

| Role | Used by | Variable |
| --- | --- | --- |
| `kalendr_owner` | The release step only | `DATABASE_OWNER_URL` |
| `kalendr_app` | The web app | `DATABASE_URL` |
| `kalendr_worker` | The worker | `WORKER_DATABASE_URL` |

Neither the app role nor the worker role may own a table. Row-level security is forced on every tenant table, and an owner would skip it.

The release step grants the worker the same table rights as the app. It also gives the worker alone EXECUTE on the three cross-business definer functions (`kalendr_claim_outbox`, `kalendr_worker_tenants` and `kalendr_outbox_health`, which return ids and counts only), plus USAGE and CREATE on the `kalendr_jobs` schema, where pg-boss keeps its tables. If the worker role does not exist yet, the release step warns and skips its grants. Create the role, then run the release step again.

## Deploy

1. Build and tag the image with the commit SHA. CI's "Container image" job builds the same Dockerfile on every pull request.
2. Take an on-demand database snapshot (your provider's console) and note its name.
3. Run the release step against the database:
   ```bash
   docker run --rm -e DATABASE_OWNER_URL -e KALENDR_RUNTIME_ROLE=kalendr_app -e KALENDR_WORKER_ROLE=kalendr_worker kalendr:<sha> node dist/migrate.mjs
   ```
   It prints `Migrations applied in … ms; schema version …` or `Migration failed: …` and exits 1. Stop the deploy on a failure.
4. Start the new web containers with `DEPLOYMENT_VERSION=<sha>`. Wait for `/api/ready` to return 200 on each.
5. Move traffic to them, then stop the old ones.
6. Restart the workers on the same image, one at a time. A worker that gets SIGTERM finishes the messages it started and hands back the rest. If one is killed outright, its rows are taken over by another worker within 60 seconds.
7. Open a public business page and the staff dashboard. Watch Sentry for ten minutes for new issues tagged with the new release.

Migrations are written expand-then-contract: a release adds columns and tables the old code ignores, and a later release removes what the old code needed. That is what makes step 3 safe while the old version still serves traffic.

## Roll back

- **Code only (most cases).** Start the previous image tag on the web and worker. The database stays as it is: the previous code ignores what the new migration added.
- **A migration damaged data.** Stop the web app and worker, restore the snapshot from deploy step 2 into a new database (next section), point `DATABASE_URL` and `DATABASE_OWNER_URL` at it, and start the previous image. Bookings made between the snapshot and the stop are lost; export them from the damaged database first if it still answers.

Never run a down-migration by hand on production. Drizzle migrations here are forward-only.

## Restore a backup

Done for real on 2026-11-12 against the local PostgreSQL 18.6 container used by the browser tests (a full seeded Kalendr database). Steps and timings:

1. Dump the source database in custom format (0.18 s, 228 KB):
   ```bash
   pg_dump -Fc -d kalendr -f kalendr-$(date +%F).dump
   ```
2. Create an empty database owned by the owner role and restore into it (0.44 s). Run as the admin role so the grants to the runtime role come back too; the `kalendr_owner` and `kalendr_app` roles must already exist on the target server (see "One-time database provisioning"):
   ```bash
   createdb -O kalendr_owner kalendr_restore
   pg_restore --exit-on-error -d kalendr_restore kalendr-2026-11-12.dump
   ```
   A non-zero exit, or any error line, means the restore is not usable. Drop the database and try again.
3. Compare the restored copy with the source. Each check below matched exactly on 2026-11-12:
   - Row counts per table are identical (36 tables).
   - `select kalendr_schema_version();` returns the same value in both.
   - Row-level security is still forced: `select count(*) from pg_class where relrowsecurity and relforcerowsecurity and relnamespace = 'public'::regnamespace;` gives the same number (29).
4. Start one web container with `DATABASE_URL` pointing at the restored database as the runtime role, and check `/api/ready` returns 200 with `database: ok` and `migrations: ok`. Then open a public business page.
5. Switch `DATABASE_URL` and `DATABASE_OWNER_URL` for the web app, worker and release step to the restored database, and restart them one at a time.

Files, keys and point-in-time restore have their own guide: [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md). A restore drill covering both was run on 2026-11-12.

On a managed database, use the provider's point-in-time restore into a new instance instead of `pg_dump`. Then run the same three checks (row counts, `kalendr_schema_version()`, `/api/ready` against the restored copy) before you switch the app to it.

## Rotate a secret

| Secret | How | Effect on users |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Set the new value, deploy the web app. | Every staff and customer session ends; they sign in again. |
| Business data keys | Yearly by the `key-rotation` job, or at once by an owner or admin: **Settings → Data protection → Replace key now**. The `storage-re-encrypt` job then moves older rows and files to the new key in batches and retires the old version. | None. Old and new records both open throughout. |
| `KALENDR_RECORDS_KEY` | Do not change it. It is the old server-wide key (key version 0). Keep it until every business's Data protection screen shows "All on the current key"; after that it opens nothing, and can be removed once no backup in the retention window still holds version 0 rows ([BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md)). | Changing it while version 0 rows exist makes them unreadable. |
| KMS master key | Turn on AWS automatic key rotation for `KMS_KEY_ID`; wrapped data keys keep working. Never schedule deletion of a master key that wrapped any data key in a backup still kept. | None. |
| `KALENDR_LOCAL_MASTER_KEY` | Development only. Changing it makes every business's wrapped keys unusable; the app names the mismatch instead of returning garbage. | Local data unreadable. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Create a new access key, update both, restart web and workers one at a time, delete the old key. Prefer an instance role over keys. | None. |
| Database passwords | `ALTER ROLE kalendr_app PASSWORD '…'`, update `DATABASE_URL`, and restart the web containers one at a time. Do the same for `kalendr_worker` with `WORKER_DATABASE_URL` and the workers, and for the owner role with `DATABASE_OWNER_URL`. | None if restarted one at a time. |
| `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` | Create a new key in Sentry, deploy, then revoke the old key. | None. |
| Email provider key | Create a new key with the provider, update it, restart the worker, revoke the old key. | None; queued messages wait in the outbox. |

After any rotation, check `/api/ready` and sign in once.

## Alerts and what to do

Set these up in Sentry (errors) and in your log platform.

Every 30 seconds each worker writes a JSON log line, `"msg":"worker heartbeat"`, with its `workerId` and four counts: `pending`, `oldestPendingSeconds`, `deadLetters` and `tenantsWithDeadLetters`. It also updates its row in `worker_heartbeats`. A clean stop sets `stopped_at` on that row. Each repeating job logs `"msg":"timed job finished"` with its counts, or `"msg":"timed job failed"`.

| Alert | Means | Do this |
| --- | --- | --- |
| New Sentry issue on the web app | An unexpected server error. Validation and permission errors are not reported. | Open the issue, copy its `request_id` tag, and search the logs for it to see the route and tenant. Roll back if it started with a release. When a visitor quotes the "Reference" from the error screen, search Sentry for `error_digest:<reference>` or the logs for `"errorDigest":"<reference>"`. |
| `/api/ready` returns 503 | The database is unreachable, or the code expects a newer migration than the database has. | `database: unavailable` → check the database status and connection limit. `migrations: behind` → the release step did not run or failed; run it. |
| No worker heartbeat for 90 seconds | Every worker stopped or cannot reach the database. Messages queue but are not sent, and reminders are not queued. | Check the worker containers are running and read their logs. Restart them. Nothing is lost: the outbox keeps every item. |
| `oldestPendingSeconds` above 600 | The worker runs but cannot keep up, or a provider is failing and items are backing off. | Read the worker logs for `outbox job failed`. Raise `WORKER_CONCURRENCY` or add a worker. If one provider is down, wait: items retry at 5 s, 10 s, 20 s and so on, eight attempts in all (about ten minutes), before they become dead letters. |
| `deadLetters` rising | Items failed eight times, were invalid, or (in production mode) have no provider connected for their channel (`provider_not_configured`). They will not be retried on their own. | Owners and admins see them on **Messages → Not sent**, with the reason and a **Try again** button. Each retry is audited as `message.retry`. Fix the cause first, for example by connecting the provider. Then use Try again, from the screen or with `POST /api/staff/messages/<id>/retry`. Don't edit outbox rows by hand. |
| `timed job failed` in the logs | A repeating job (reminder sweep, hold expiry, retention, dead-letter report) threw. pg-boss retries it twice. | Read the `job` field and the error summary. A failing reminder sweep means reminders are not being queued: treat it like a stopped worker. |

## Logs

Logs are JSON lines from `pino`, one per event, with `requestId`, `tenantId` and `route` where they exist. Phone numbers, emails, names, tokens, codes and message bodies are redacted by key and by pattern before a line is written, so a mistaken `log.info({ phone })` prints `[redacted]`. `src/server/logger.test.ts` proves this. Never add a log line that prints a request body.

## Branch protection (owner, once)

CI (`.github/workflows/ci.yml`) runs on every pull request. For a failing journey to block a merge, on GitHub open **Settings → Branches → Add rule** for `main` and turn on **Require status checks to pass before merging**, then choose **Checks**, **PostgreSQL 18 acceptance**, **Browser journeys** (the job that waits for all eight journey shards) and **Container image**. Also turn on **Require branches to be up to date before merging**.

## Release checklist

Copy this into the release pull request.

- [ ] `pnpm check` passes (lint, typecheck, unit tests, build).
- [ ] `bash scripts/verify-postgres18.sh` passes (migrations, row-level security and the database integration tests on PostgreSQL 18).
- [ ] `pnpm e2e` passes on desktop and phone, with no serious accessibility findings.
- [ ] `pnpm knip` and `pnpm audit:deps` pass.
- [ ] CI is green on the pull request, including **Container image**.
- [ ] New environment variables are in `.env.example` and set in production.
- [ ] New migrations are expand-only, or the contract step's earlier release is already live.
- [ ] A database snapshot was taken before the release step.
- [ ] After deploy: `/api/ready` is 200, a public page and the staff dashboard open, Sentry shows no new issues for ten minutes.

## Known limits

- In production the worker sends email through Resend when `RESEND_API_KEY` and `EMAIL_FROM` are set. WhatsApp and SMS messages go to dead letter as `provider_not_configured`, until their provider keys are set, and staff can retry them then. `compose.yaml` runs the worker in local capture mode, which needs a loopback database address, so it shares the database container's network.
- pg-boss creates its tables in `kalendr_jobs` on the worker's first start, so the worker role owns them. The owner role cannot read them without a grant.
- Calendar renewal is scheduled hourly but does nothing until calendar sync (feature 16).
- Protected storage (feature 10) was run only against local MinIO, ClamAV and the local key provider. Real S3, real KMS and a production restore are not verified.
- Deploy order for protected storage: run the release step, then deploy web and worker together. Old web code still writes key version 0, and would fail for a business whose version 0 is already retired; that happens only after the re-encryption job finishes, so do not roll back across this release once it has.
- A file stays pending (cannot be opened) if ClamAV is down for longer than the scan's 8 attempts (about 21 minutes). `storage-health` logs `filesWaitingForScan`, and the dead `file.scan` rows count in the worker's dead letters. Once ClamAV is back, an owner or admin presses **Try again** on those rows in the Messages screen's **Not sent** panel (they are listed there with the messages).
- An administrator's **Replace key now** rotates at once; moving existing items to the new key follows on the next `storage-re-encrypt` run (every 10 minutes). A version with a pending or infected item is not retired until that item is gone or scanned.
- A staff photo or business picture is hidden (initials or no picture) until its scan is clean.
- `KALENDR_RECORDS_KEY` cannot be rotated in place.
- Nothing deletes expired `rate_limit_buckets` rows yet (`deleteExpiredRateLimitBuckets()` waits for the job scheduler, feature 1). The refused-request counter `kalendr.rate_limit.refused` has no metrics exporter; use the log line.
- CI has not run on GitHub: the project has no GitHub repository yet. Until it does, run the release checklist's commands by hand.
- The restore above was timed on a small seeded database. Time a restore of the real database's size on the production provider before relying on these numbers.
