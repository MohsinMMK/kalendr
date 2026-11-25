# Build standards

How to run the build sessions and the quality bar every feature must clear. Read this before any feature file.

## 1. Session settings

| Setting | Value |
| --- | --- |
| Model | **Opus 5.5** (`claude-opus-5-5`) |
| Effort | **High** |
| Scope | **One feature per session, one branch per feature** (`feat/NN-short-name`), merged before the next starts |
| Largest features | 16, 23 and 30 are split into two or three sessions at the steps marked "Session break" |

Why one feature per session: each feature touches the schema, the server, the screens and the tests. A session that tries three at once loses track of migrations and leaves half-finished work.

**Start every session with this, in order:**

1. Read `AGENTS.md`. This project runs Next.js 16, which differs from older versions. Before writing any page, route, proxy or config code, read the matching guide in `node_modules/next/dist/docs/`. Request interception lives in `src/proxy.ts`, not `middleware.ts`.
2. Read `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.
3. Read this file, then the feature's own section.
4. Query the knowledge graph for the area you are about to change: `graphify query "<question>"` (see `graphify-out/GRAPH_REPORT.md`).
5. Check the latest version of each library the feature names with `pnpm view <name> version`, and read its current docs. Versions in this plan were correct on 12 November 2026.
6. Load the `coss` skill before building any screen. Load the `claude-api` skill before writing feature 30.

**End every session with this:**

1. `pnpm check` passes (lint, typecheck, tests, build).
2. Database tests pass: `scripts/verify-postgres18.sh`.
3. The feature's "Done when" is shown working in a real browser, on desktop and phone width.
4. Docs updated (section 6).
5. Commit only when the owner asks.

## 2. Code quality bar

### TypeScript

- Strict mode stays on. No `any`, no `as` casts to silence errors, no `@ts-ignore`, no non-null `!` on values that can be missing.
- Parse everything that crosses a boundary with Zod: request bodies, query strings, webhook payloads, provider responses, environment variables, stored JSON columns. Derive the TypeScript type from the schema (`z.infer`), never the other way round.
- Shared request and response shapes go in `src/lib/contracts.ts` or `src/server/contracts.ts`, next to the ones already there.
- Functions do one thing. A file that passes about 400 lines is split by responsibility.
- Comments say **why**, in plain words, and only where the code cannot. Match the comment style already in `src/db/schema.ts`.

### Server and API

Every route follows the shape already used in `src/app/api/staff/waitlist/route.ts`:

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "appointments.book");
    return dataResponse(await doTheWork(context, await parseJsonBody(request, inputSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.thing.create", requestId);
  }
}
```

- Routes stay thin. The work lives in `src/server/*`.
- Errors use `ApiError` and the existing shape `{ error: { code, message, fieldErrors? } }`. Messages are plain sentences a receptionist can act on.
- Every new action gets a permission key in `src/lib/permissions.ts`, a default per role, and a test.
- Every change that a person could repeat by double-clicking takes an `Idempotency-Key`.
- Every change to a row that two people can edit checks `version` and returns `version_conflict` when stale.
- Every change writes an `audit_events` row in the same transaction.
- **No outside call inside a request.** Write an `outbox_events` row; the worker calls the provider. The only exceptions are creating a payment order and verifying a bot-protection token, because the customer is waiting on the answer.

### Database

- Every new table that holds business data has `tenant_id`, a composite unique `(tenant_id, id)`, composite foreign keys to its parents, **forced row-level security**, and a policy on `current_setting('app.tenant_id')`. Copy the pattern from an existing migration.
- Access only through `withTenant`. Work that must cross tenants (worker claim, webhook lookup, admin console) uses a narrow `SECURITY DEFINER` function that returns ids only, like `kalendr_resolve_tenant`. Never give the runtime role `BYPASSRLS`.
- Rules live in the database, not only in code: unique indexes, check constraints, exclusion constraints for anything that must not overlap.
- Money is an integer in the smallest unit (`amount_minor`, paise or cents) with a `currency` column. Never a float.
- Times are `timestamptz`. Convert for display with `@date-fns/tz` using the location's timezone.
- Secrets and contact details stored for later use (OAuth tokens, gateway keys, message destinations) are encrypted with `src/server/record-crypto.ts` until feature 10 moves this to managed keys.
- Migrations come from `pnpm db:generate`. Read the SQL before committing. Add row-level security by hand where the generator does not. A migration must run safely on a database that already has data: add nullable or defaulted columns first, backfill, then tighten.
- Never edit a migration that has been merged.

### Webhooks (payments, delivery status, calendar, WhatsApp)

Every incoming webhook route does these five things in this order:

1. Read the **raw body** before parsing.
2. Verify the signature with a constant-time compare. Reject with 401 on failure.
3. Record the provider's event id in a dedupe table; return 200 immediately if it was seen before.
4. Write the event and an outbox row in one transaction. Do no other work.
5. Return 200 fast. The worker does the rest.

### Screens

- **Use the official coss compositions** from `src/components/ui`. Do not hand-build a dialog, select, menu, tabs, toast or form field. Find examples with the `coss-particles` skill. The result must feel like a real appointment system, not a demo.
- Follow `DESIGN.md` and `PRODUCT.md` for tone, spacing and colour.
- Every screen has all five states: loading, empty, error with a way to retry, partial, and full.
- Works at 360px wide. Touch targets are at least 44px.
- Works with a keyboard alone and with a screen reader. Every input has a label. Colour is never the only signal.
- Words come from the terminology system (`useTerms`) so a salon sees "stylist" and a clinic sees "doctor". No hard-coded "patient" or "doctor" in new screens.
- Write screen text the way a person talks: short sentences, no jargon, say what happened and what to do next.
- Forms use `react-hook-form` with the Zod resolver and show server field errors beside the field.
- Preview mode (`KALENDR_PREVIEW_MODE`) keeps working. New features either have honest demo data or are clearly labelled as unavailable in preview.

### Security

- Never log a phone number, email, name, token, code, message body or record content. Log ids and a request id.
- Tokens are 256-bit random and stored as SHA-256 hashes, as manage links are today.
- Compare secrets in constant time.
- Any new script or frame source is added to the CSP in `src/lib/security-headers.ts` and `src/proxy.ts`, with the nonce.
- Public endpoints get a rate limit (feature 9) before they ship.
- New environment variables are added to `.env.example` with a comment, validated at startup, and never have a working default in production.

## 3. Tests each feature must add

| Kind | Tool | What to cover |
| --- | --- | --- |
| Unit | Vitest | Every pure rule: pricing, policy windows, routing order, template rendering, signature checks |
| Component | Testing Library | Each new screen's states and its main interaction |
| Database | Vitest integration (`*.integration.test.ts`) against PostgreSQL 18 with the non-owner role | The change works; **business B cannot read or change business A's rows**; constraints reject bad data; two requests at once do not both win |
| Provider | A fake adapter | Send, retry, permanent failure, duplicate webhook, bad signature. No test calls a real provider |
| Browser | Playwright (after feature 35) | The feature's main journey on desktop and phone width, with an accessibility scan |

Tests assert behaviour, not implementation. A test that only checks a mock was called is not enough.

## 4. Definition of done

A feature is done only when all of these are true:

- [ ] The "Done when" in its section is demonstrated in a real browser against a real local database.
- [ ] `pnpm check` and `scripts/verify-postgres18.sh` pass.
- [ ] New tables have row-level security and a cross-tenant test.
- [ ] Every new mutation has permission, idempotency where needed, version check where needed, and an audit row.
- [ ] No provider is called from inside a request (except the two named exceptions).
- [ ] Screens use coss compositions, have all five states, and work at 360px and by keyboard.
- [ ] New words go through the terminology system.
- [ ] `.env.example`, the feature's doc, and `docs/PLATFORM_ROADMAP.md` are updated.
- [ ] Anything not finished is written down in the feature's doc under "Known limits". Nothing is described as working unless it was tested.

## 5. Things not to do

- Do not rename `patients`, `practitioners` or the `clinic` folders.
- Do not add Redis, a second database or a message broker. PostgreSQL does the queueing.
- Do not add a UI kit beside coss. Do not add a state library beyond what a feature names.
- Do not enable generic sign-up in better-auth. Owners register through `/start`; staff are invited.
- Do not weaken a row-level security policy to make a query easier.
- Do not send a real message, charge a real card or call a live provider from a test or a local run.
- Do not claim compliance (DPDP, HIPAA, ABDM) anywhere in the product or docs.

## 6. Docs to keep current

| When you | Update |
| --- | --- |
| Add a table or migration | `docs/ARCHITECTURE.md` and the note in `docs/PLATFORM_ROADMAP.md` about migrations to apply |
| Add an environment variable | `.env.example` |
| Add a provider or webhook | `docs/SECURITY.md` and `docs/WORKER.md` |
| Finish a feature | Tick it in this folder's `README.md` and add a dated note in `docs/verification/` with what was tested and how |
| Change many files | Refresh the knowledge graph with `/graphify --update` |
