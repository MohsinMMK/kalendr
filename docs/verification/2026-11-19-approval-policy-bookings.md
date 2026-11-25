# Features 41, 42, 43 verification (19 November 2026)

Branch `claude/w2c-sched-41-43-b4766c`. Migrations 0042, 0043, 0044.

Tested on a throwaway PostgreSQL 17 (PostgreSQL 18 and Docker were not available on the builder's machine), prepared with `scripts/e2e-database.mjs`, with the non-owner runtime role. Integration tests: `src/server/approval.integration.test.ts` (8), `src/server/cancel-policy.integration.test.ts` (8), `src/server/bookings-list.integration.test.ts` (6). They run only when `DATABASE_URL`, `KALENDR_TEST_OWNER_URL`, `WORKER_DATABASE_URL` and `KALENDR_PREVIEW_MODE=false` point at a scratch database (the port guard in `src/server/testing/scratch-database.ts` accepts 5544, 5545 or `KALENDR_TEST_SCRATCH_PORT`).

See the report at the top of the commit history for each Done-when and whether it passed. Browser checks: see the lane report.
