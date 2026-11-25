# Local clinic onboarding acceptance — 9 October 2026

Refined clinic registration, resumable operational setup, and landing-page
guidance while preserving Kalendr’s existing patient and staff workflows. Updated
the scheduling and authentication dependencies, added owner email-verification
delivery, and fixed the account-schema compatibility required by Better Auth.

## Scope and sources

See [onboarding research](../ONBOARDING_RESEARCH.md) for official documentation,
Cal.com community source, Formbricks source, and independently implemented
decisions. This is local acceptance, not deployment or production acceptance.

## Automated verification

- `KALENDR_NEXT_DIST_DIR=.next-onboarding-build pnpm check` — lint, strict TypeScript,
  94 unit/component tests, and production build passed. Four database tests were
  intentionally skipped without the isolated database environment.
- `pnpm test` after adding four production registration-gate cases — 98 tests
  passed across 33 files; the four database tests remained skipped.
- `pnpm test src/server/clinic-registration-gate.test.ts && pnpm lint` — four
  gate cases passed, including explicit production authorization, required
  verification delivery, and the development closed-gate override; lint passed.
- `pnpm typecheck` after the added gate tests — passed.
- Database integration command below — all four tests passed against the project
  database, including clinic creation → service → chair → reviewed hours → ready
  catalog, tenant isolation, booking conflicts, and inactive-catalog behavior.
- `scripts/local-db.sh migrate` — auth-account migration applied successfully.
- `scripts/local-db.sh check` — seed data, password hashes, tenant isolation,
  and runtime access denial without clinic context passed.
- `pnpm audit --prod` — no known vulnerabilities found.
- Impeccable’s deterministic design review returned no findings.

Exact database test invocation (credentials are loaded from ignored local files):

```sh
bash -c 'source .local-db/database.env; export KALENDR_TEST_OWNER_URL="postgresql://kalendr_local_owner:$KALENDR_LOCAL_OWNER_PASSWORD@127.0.0.1:5544/kalendr_local"; scripts/local-db.sh run pnpm test src/server/appointment-repository.integration.test.ts'
```

The 98 normal tests and four separately executed database cases cover all 102
current tests. The build used a separate output directory so browser development
could continue without sharing generated files. Test concurrency is bounded to
two workers for reliable local execution.

## Browser acceptance

Headed Playwright exercised the database-backed app at `http://localhost:3101`:

- Registration: explicit city/address, owner practice details, account review,
  and successful creation followed by automatic sign-in to `/setup`.
- Setup: 30-minute consultation with clinic approval and a chair requirement;
  compatible chair creation; reload on the remaining-hours stage preserved
  saved configuration; weekdays with explicitly edited 09:00–13:00 hours.
- Readiness: final summary linked to the new clinic’s patient page. Public
  choices showed the configured location, service, practitioner, and matching
  weekday openings through 12:30 for a 30-minute visit.
- Patient journey: new patient → self → location/service → live time → contact
  and consent → review → persisted request; private manage link showed the same
  requested visit. The staff schedule showed the request on its appointment date;
  the clinic reviewed and approved it, producing the persisted Booked status.
- Desktop and 390px onboarding review were visually inspected; long booking
  addresses wrap and there is no document-level horizontal overflow.
- The updated landing page was inspected at 1440px and 390px after content and
  fonts loaded; neither viewport has document-level horizontal overflow.

Local screenshots remain in ignored `output/playwright/`. Initial real sign-in
revealed the old required `issuer` field; after applying the compatibility
migration, fresh registration and automatic sign-in passed. Playwright locator
timeouts from targeting visually hidden radios or expecting different heading
text were corrected by selecting visible labels and observed page content.
The two fictional browser acceptance clinics, their owner accounts, and their
patient request were removed from the isolated local database after verification;
the existing seeded clinics were retained.

## Operational limits

No new environment-variable names were introduced. The already-supported
`KALENDR_ALLOW_CLINIC_REGISTRATION` gate is now documented in `.env.example`; public
production registration requires it plus the existing verification, sender, and
Resend settings. The isolated local runner explicitly bypasses email verification
for fictional development accounts; the production gate forbids that bypass.

Email sending was tested with a mocked provider, with no real outbound messages.
Appointments still use the existing notification outbox. Real sender delivery,
SMS, clinic policies, deployment configuration, and physical-device acceptance
remain production checks. Local PostgreSQL is 17.11; the configured 18.6 container
has not been independently validated in this pass.

The workspace started with an unborn local Git repository, untracked application
files, and no remote. The requested source work is recorded as an initial local
commit; no hosted repository is created and no push or deployment is claimed.
