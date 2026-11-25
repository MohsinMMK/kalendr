# Isolated local PostgreSQL for Kalendr

This workflow starts a Kalendr-only PostgreSQL cluster without Docker. It keeps
its data and credentials under the ignored `.local-db/` directory and binds
TCP to `127.0.0.1:5544`. It does not connect to any existing local database or
remote service.

## Start, migrate, seed, and run

From the repository root:

```bash
scripts/local-db.sh start
scripts/local-db.sh migrate
scripts/local-db.sh seed
scripts/local-db.sh run pnpm dev
```

`start` requires `initdb`, `pg_ctl`, `psql`, and `openssl` on `PATH`. `migrate`
runs the release step, `scripts/migrate.mjs`, as the owner, so the local web and
worker roles get the same grants as production; it and `seed` require the
installed Node dependencies. The
script chooses port 5544 and refuses an unrecognized `.local-db` directory.
If another service already uses that port, PostgreSQL startup fails without
touching that service.

A `.local-db` made before the product was renamed keeps working. The script
recognises its older marker and keeps that cluster's role names, database name
and env keys, so nothing inside `.local-db` has to be renamed or moved. New
clusters get the `kalendr_local` names. In an older cluster the seeded
`lotus-dental` owner is `nira.owner@example.com` (the credential file lists it),
not `kalendr.owner@example.com`.

The migration login owns the local database and has `BYPASSRLS` so the
committed security-definer tenant and staff resolvers can look up the right
business. The web login is a separate non-owner `NOSUPERUSER NOBYPASSRLS` role
with table access, execution of every function except the worker-only ones, and no update/delete access
to audit events. `run` gives the child process only the web login URL and local
Better Auth settings; Drizzle migrations always use the owner URL.

`seed` adds three fictional businesses, each with one location, two providers,
two services, two resources and Monday–Saturday availability:

- `lotus-dental`, business type dental;
- `riverbend-care`, business type healthcare;
- `cedar-hair` (Cedar Hair Studio), business type wellness (salon, spa and
  fitness), with stylists Rohan Desai and Tara Iyer, the services Haircut and
  Hair colour, and two stations.

Staff identities with memberships are created for each. Tables keep their
original clinic names (`tenants`, `practitioners`, `patients`), so the salon's
stylists are stored as practitioners. The seed is safe to rerun: seed-owned IDs
are stable and inserts preserve existing rows, while the seed refreshes each
demo service's supported customer types and each business's type. Passwords
for the local-only Better Auth identities are generated in
`.local-db/staff-credentials.json` with owner-only file permissions. If that
file already exists, the seed adds passwords for new staff and keeps the
existing ones. The owner accounts are `kalendr.owner@example.com`,
`riverbend.owner@example.com` and `cedar.owner@example.com`; provider accounts
are in the credential file. No messages are sent to these addresses.
Credentials are never printed by the scripts. `scripts/seed-demo-bookings.mjs`
fills only `lotus-dental` with sample bookings.

A new real business is created in the product at `/start` (not by enabling
Better Auth signup), starting with its business type. The owner then finishes
services, resources, and providers at `/setup`. Generic `BETTER_AUTH_ALLOW_SIGNUP` stays false. Local `run`
sets `KALENDR_ALLOW_CLINIC_REGISTRATION=true` and explicitly disables email
verification for isolated local identities, so `/start` works without an email
provider. Production registration requires that flag, required email
verification, and configured `RESEND_API_KEY` / `EMAIL_FROM`. Public owners are
unverified until they follow the verification link; owner-provisioned team
accounts retain the existing business-controlled identity policy. No verification
or appointment messages are sent by local acceptance tests.

## Verify and stop

```bash
scripts/local-db.sh check
scripts/local-db.sh status
scripts/local-db.sh stop
```

`check` uses the actual web login. It verifies that no business row is visible
without a tenant context, each context exposes only its own business's data,
cross-business writes fail under RLS, the runtime role cannot bypass RLS, and a
seeded credential matches the Better Auth hash. `stop` preserves all local
data. To restart, run `start`; migrations and seed can be rerun independently.

The currently installed Homebrew PostgreSQL is **17.11**. The native workflow
uses that version. A separate, repeatable PostgreSQL **18.6** acceptance run is
available with Docker:

```bash
scripts/verify-postgres18.sh
```

It starts a disposable `postgres:18.6` container on `127.0.0.1:5545`, creates
separate migration and runtime roles, applies migrations, seeds fictional
businesses, verifies runtime isolation and credentials, and runs the four database
integration cases. Generated credentials remain in a private temporary
directory. The container and directory are removed on exit; the native cluster
is not changed. Docker, OpenSSL, pnpm, and installed dependencies are required.
This acceptance passed on 10 October 2026. Production backups/restore and the
deployed database configuration remain separate release gates.
