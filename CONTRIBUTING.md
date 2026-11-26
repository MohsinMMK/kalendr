# Contributing to Kalendr

Thank you for helping. Kalendr is source-available under the terms in [LICENSE](LICENSE);
by opening a pull request you agree that Khanect may use, change and distribute your
contribution as part of Kalendr under those or any later terms.

## Before you start

- Read [docs/STATUS.md](docs/STATUS.md). It lists what is done, what is partial and what
  blocks launch, and links each feature's detail.
- For anything larger than a small fix, open an issue first so we can agree the approach.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Local setup

Use Node.js 24 LTS and pnpm 11, then follow [Local setup](README.md#local-setup) in the
README. `pnpm dev` runs with preview data and needs no environment file; the
[Database](README.md#database) section adds PostgreSQL 18.

## Making a change

- Keep a change to one purpose, and match the code around it: TypeScript strict, coss UI
  components, Drizzle for the database, Zod at the edges.
- Schema changes need a migration made with `pnpm db:generate` and reviewed by hand.
  Every tenant-owned table keeps row-level security.
- Words on screen follow the business type (customer, provider, appointment and so on);
  use the wording helpers rather than fixed clinic words.
- Update [docs/STATUS.md](docs/STATUS.md) and the feature's doc when behaviour changes.

## Checks

Pull requests must pass CI: lint, type checking, unit tests, unused-code and dependency
checks, the PostgreSQL 18 acceptance suite, the container build and the browser journeys.
Run the same locally before you push:

```bash
pnpm check
scripts/verify-postgres18.sh
pnpm e2e
```

Add or update tests with the change: unit tests beside the code, database tests as
`*.integration.test.ts`, and journeys in `e2e/`.

## Pull requests

Describe what changed and why, how you tested it, and include screenshots for anything
visible. Keep commit messages in plain sentences that say what the change does.
