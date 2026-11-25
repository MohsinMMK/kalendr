# Production worker and scheduler (feature 1) — 12 November 2026

What was built:

- The outbox worker now has a production mode next to `local_capture`.
- It runs as its own database role, `kalendr_worker`, with no `BYPASSRLS`.
- It claims work through `kalendr_claim_outbox`, a `SECURITY DEFINER` function that returns ids only.
- pg-boss 12.38.2 runs five repeating jobs.
- A 30-second heartbeat.
- A graceful shutdown.
- A **Not sent** panel on the Messages screen with **Try again** (`messages.retry`).

Everything below ran on this machine. The local cluster was PostgreSQL 17 on `127.0.0.1:5544`, worker role `kalendr_local_worker`. The disposable databases were PostgreSQL 18.6, one from `scripts/verify-postgres18.sh` and one from the e2e script.

Every run used `KALENDR_WORKER_MODE=local_capture`. No provider was called, and none exists yet.

## "Done when", one by one

All rows below come from `src/worker/outbox-worker.integration.test.ts`. It connects as the real worker role, not as the owner.

| Criterion | What was done | Result |
| --- | --- | --- |
| Two workers process a confirmation exactly once | Two worker connections drain the same 41 due rows at the same time: the appointment's `appointment.created` and 40 counted test events | Both workers took part. No row was finished by both. All 41 are `delivered`. Each counted handler ran once, and the appointment has one `appointment.created` notification. Run 10/10 on the local cluster and in `verify-postgres18.sh`. |
| Retries come at 5, 10 and 20 s; dead letter after 8 attempts | A handler that always returns `retry`. Each round claims, handles and reads `available_at − now`, then moves the row's time forward instead of waiting | Delays of 5 000, 10 000 and 20 000 ms, then doubling (the full list matches `retryDelayMs`). `failed` with `last_error_code = test_failure` up to attempt 7, then `dead_letter` on attempt 8. A dead letter is never claimed again. |
| A killed worker's rows are released within 60 s | Worker A claims a row and "dies". Worker B tries to claim it with `locked_at` 0 s, 59 s and 61 s in the past | Not claimable at 0 s or 59 s; taken over at 61 s. Worker A's late write gets `lease_lost` because its lease token no longer matches. Worker B delivers it, with `attempt_count` 2. **The time is simulated** by moving `locked_at` back; no real 60-second wait. |
| A moved-appointment reminder is dropped | One reminder is queued for version *n*. The appointment moves to *n + 1* and a second reminder is queued | Both rows are `delivered`. Only one reminder notification exists, the one for the new version. The appointment's `reminder_status` is `delivered`. |
| Graceful shutdown hands back unstarted rows | `runOutboxBatch` with `shouldStop` set after two rows | At most 2 delivered. Every other row is `pending` with `attempt_count` 0 and no lease. |
| Worker sees nothing without a business | Query `appointments` as the worker role with no `app.tenant_id` | 0 rows. `rolbypassrls` and `rolsuper` are both false. |
| Cross-business functions are kept from the web app | Call the three definer functions as the runtime role | `42501 permission denied` on each. |
| Try again resets the event and writes an audit row | `retryUndeliveredMessage` from `src/server/message-retry.ts` | Receptionist: 403. Another business: cannot see it, and retry returns 404. Stale `attemptCount`: 409. Admin: `pending` with 0 attempts. Same idempotency key again: the same answer, not applied twice. One `message.retry` audit row. |
| Repeating jobs are installed | `startScheduler` as the worker role | All five schedules are in `kalendr_jobs.schedule` with their cron. No job errors. |

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm check` (ESLint with `--ignore-pattern '.claude/**'`, typecheck, unit tests, `next build`, `build:jobs`) | Passed. Unit tests: 71 files, 530 passed, 31 skipped (database suites without a database). `dist/worker.mjs` and `dist/migrate.mjs` built. |
| `pnpm exec vitest run src/worker/worker.test.ts` | 11 tests pass: configuration guards, the handler map, schedules, and the production sink against a fake adapter. |
| Worker integration on the local cluster (`scripts/local-db.sh run pnpm exec vitest run src/worker/outbox-worker.integration.test.ts`, with `KALENDR_TEST_OWNER_URL`) | 10 of 10. It also passed in repeated runs. |
| `scripts/verify-postgres18.sh` | Exit 0: 4 files, 26 tests, including the worker suite against a throwaway PostgreSQL 18.6. |
| `KALENDR_E2E_PORT=5547 KALENDR_E2E_SKIP_BUILD=1 scripts/e2e.sh` | 16 passed (8 desktop, 8 phone) in 1.3 min. Port 5546 was already taken by another container, so 5547 was used. |
| `pnpm exec knip` | Warnings only, which is how the config sets these rules. Unused exports from this feature were removed. Three are kept exported on purpose: `ProviderSendRequest`, `ProviderSendResult` and `DeliveryOutcome`, which are the adapter contract for features 2–4. |
| `scripts/local-db.sh run pnpm worker:local` (live, about 8 s, then Ctrl-C) | `worker heartbeat` (pending 0, oldest 0 s, dead letters 0), `worker started` (local_capture, concurrency 4), timed-job lines, `worker stopped`, exit 0. No phone number, email or name in the output. |

## Browser check: Messages → Not sent

Setup:

- The `pnpm dev` server ran on port 3002 against the local cluster.
- I signed in as the seeded owner of `nira-dental`.
- I added two test outbox rows: a `dead_letter` booking confirmation (`provider_not_configured`, 8 tries) and a `failed` reminder (`rate_limited`, 3 tries).
- The viewport was 360 × 780.

What I saw:

- **Layout.** The panel lists both rows, each with the person, what the message was about and when, the reason in plain words, the try count, an "Open the visit" link and a status badge. The page has no horizontal scroll (`scrollWidth` 360).
- **Keyboard: filter.** Tab from Refresh reaches the filter. Arrow keys and Space select "Gave up", and the list shows only the dead letter.
- **Keyboard: Try again.** Tab reaches "Open the visit" and then "Try again: Booking made for …". Enter sends `POST /api/staff/messages/:id/retry`.
  - The row went back to `pending` with 0 attempts and no error code.
  - One `message.retry` audit row was written, with event id, type, earlier status, code and count. It holds no personal data.
  - The success toast appeared, and "Gave up" showed its empty state.
- **Found and fixed.** Once the row was gone, keyboard focus fell to `<body>`. Focus now moves to Refresh after a successful retry, and I confirmed this in the browser with a visible focus ring.
- **Cleanup.** The test rows, their audit rows and the two idempotency keys were deleted afterwards.

During the check, the browser lost its staff session cookie twice while the session row was still valid in the database. Cookies on `localhost` are shared across ports, so another local session signing in or out on a different port most likely replaced it. Signing in again fixed it each time. This is not related to this feature.

## Not tested

- **The new compose worker in a container.** The image was not built or run with `docker compose --profile app up worker` and `WORKER_DATABASE_URL`. Feature 35 ran the image's worker before this change.
- **Real providers.** None exist. Production mode was checked only with unit tests: against a fake adapter, and with no adapter, which gives `provider_not_configured`.
- **Two separate worker processes.** The exactly-once test uses two worker connections in one process. Each has its own sessions and leases, so the database race is real, but they are not two OS processes.
- **A real 60-second wait.** See "Known limits".
- **Scheduled times.** pg-boss's schedule rows were checked. A job firing at its real minute, hour or night was not watched, beyond the first runs in the live start.

## Known limits

- **No provider adapters.** In production mode every message goes to dead letter as `provider_not_configured` until features 2–4 add them.
- **Calendar renewal is a no-op** until calendar sync (feature 16).
- **A send can repeat after a rollback.** If the database transaction rolls back after a provider accepted a message, the next attempt sends again. The provider idempotency key (stable across attempts) is what stops a duplicate, and that relies on each provider honouring it.
- **The lease test simulates time.** It moves `locked_at` back instead of waiting 60 s.
- **A test claim is global.** `kalendr_claim_outbox` takes any business's due rows. On a shared dev database the integration test hands back rows it isn't about, but a test round can still deliver other due dev rows in local_capture.
- **pg-boss tables belong to the worker role**, because pg-boss creates them on first start. The migration owner does not own them.
- **A dead letter can keep a handler's own code.** When a handler returns a coded retry on the 8th attempt, `last_error_code` keeps that code, for example `rate_limited`, instead of `retries_exhausted`.
- **Two runs at start.** `reminder-sweep` and `hold-expiry` ran twice within 6 seconds of the live start. The earlier runs were most likely jobs left queued by the integration test's scheduler. Both jobs are idempotent.
- **`/api/ready` does not check the worker.** Use the heartbeat alerts in `docs/OPERATIONS.md`.
- **ESLint and Vitest scan `.claude/worktrees/`** when another session has a worktree there. `pnpm check` needed `--ignore-pattern '.claude/**'` for ESLint. Excluding that folder in both configs is a follow-up.
