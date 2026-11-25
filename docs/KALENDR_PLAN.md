# Kalendr generalization plan

Turn this clinic-only appointment app (previously branded under an older product name) into **Kalendr by Khanect**: an end-to-end appointment system any appointment-led business can set up from one link. Healthcare and dental become two business types among several, not the product.

This file is the source of truth for the work. Re-read it at the start of every phase, and tick the checklist in "Progress" at the end of every phase so the direction survives context summaries.

## Decisions already made by the owner (do not reopen)

- Product name: **Kalendr**. Company / umbrella brand: **Khanect**. Use "Kalendr" in the UI and "Kalendr by Khanect" where a full attribution fits (footer, about, metadata). The old product name must disappear completely.
- Wording adapts per business: the owner picks a **business type** at setup, which sets the words, starter services and which features are on. The owner can then **rename any word** in Settings.
- Work happens on branch `kalendr-generalization` (already created and checked out; `master` holds a checkpoint commit). Commit per phase. Never push, never merge to `master`, never switch branches.

## Guardrails

1. `AGENTS.md`: this Next.js version differs from training data. Read the relevant guide under `node_modules/next/dist/docs/` before writing Next.js code.
2. UI uses the official coss compositions. Read `.claude/skills/coss` and `.claude/skills/coss-particles` before writing markup. The result must feel like a real appointment product, not restyled primitives.
3. Do **not** touch `src/components/kloq/` (third-party calendar library with its own licence; "kloq" is not our brand).
4. Do **not** rename database tables, columns, or source files/folders (`patients`, `practitioners`, `tenants`, `src/features/clinic/…` all stay). Internal names are internal. Only what a user, a browser, an operator or a doc reader sees changes. This keeps the diff reviewable.
5. Never edit existing migration files in `drizzle/`. Schema changes go through `src/db/schema.ts` + `pnpm db:generate` (one new migration per phase that needs one). Check how row-level security policies were added in earlier migrations and give every new table the same per-tenant policy.
6. No new dependencies unless a phase cannot be done without one; say why in the commit message.
7. A dev server is already running at `http://localhost:3000` (owned by the planning session, hot reload on). Do not start a second one on port 3000 or kill that one. Use it to check your work in the browser.
8. Secrets: never print values from `.env*` files. Renaming a key inside a local `.env` file is fine.
9. Plain language in all copy. No medical wording on any screen unless the business type is healthcare or dental.
10. Gate at the end of every phase: `pnpm lint && pnpm typecheck && pnpm test` all pass, then commit. Update or add tests alongside the code; do not delete a test to make it pass. Integration tests need the local Postgres (`scripts/local-db.sh`); if it is not running, say so in the progress log rather than skipping silently.
11. Subagents are welcome for wide sweeps (for example the wording replacement in Phase 3), but give each a disjoint set of files and review their diffs before committing.
12. If something in this plan turns out to be wrong or impossible, write what you found under "Open questions" at the bottom and continue with the rest. Do not silently change scope.

## Phase 1: Rebrand to Kalendr

- Replace every use of the old product name, in any casing (about 660 occurrences in about 120 files): UI copy, page metadata, `src/app/manifest.ts`, emails, calendar files, `package.json` name, docs, `PRODUCT.md`, scripts, tests, storage keys, cookie names, custom event names, CSS class or variable prefixes.
- Environment variables with the old prefix become `KALENDR_*` (`.env.example`, `.claude/launch.json`, all readers, docs, and the keys in any local `.env*` file).
- The old widget script becomes `public/kalendr-widget.js`, including its global names, data attributes and the install snippets in `website-connection*.ts(x)`, `website-install-guide.tsx` and `src/app/embed-demo`.
- Done when: a case-insensitive search for the old name (excluding `node_modules`, `.next` and `.git`) returns nothing outside historical `drizzle/` SQL and snapshots, and the gate passes.

## Phase 2: Business types and terminology (the foundation)

- Schema: add to `tenants` a `business_type` (varchar, default `healthcare` so existing clinics are unchanged), `terminology` (jsonb overrides, default `{}`), and `features` (jsonb overrides, default `{}`).
- `src/lib/business-types.ts`: a typed registry. Ship these presets: `healthcare`, `dental`, `wellness` (salon, spa, fitness), `real_estate`, `professional_services` (agency, consulting, legal, finance), `retail` (shops, e-commerce consultations, fittings, pickups), `education` (tutoring, classes), `other` (neutral). Each preset defines:
  - Terms, singular and plural: customer (patient / client / buyer / student…), provider (doctor / stylist / agent / consultant / tutor…), business (clinic / salon / agency / store…), appointment (visit / appointment / viewing / session / meeting…), service, resource (chair / room / desk / property…), location.
  - Starter services with sensible durations and booking mode.
  - Which resource kinds make sense.
  - Feature flags: `records` (visit notes, reports, prescriptions), `recalls` (follow-ups), `dependents` (guardian booking), `dateOfBirth`, `providerCredentials` (qualifications, registration number), `customerTypes` (new / returning; no longer asked in the booking flow, kept so saved businesses still parse).
  - Provider profile field labels (for example "Specialty" becomes "Focus area" or "Role").
- `src/lib/terminology.ts`: `resolveBusinessProfile(tenant)` merges preset + overrides and returns terms and features. Provide casing helpers. Pure and unit-tested.
- Delivery: include the resolved profile in the staff snapshot (`src/lib/staff-snapshot.ts`), the public catalog (`src/server/public-catalog.ts`) and the portal payload. Add a `useTerms()` / `useFeatures()` hook backed by context in the staff shell, booking shell and portal. Server code (emails, notifications, calendar files, API error text) resolves from the tenant.
- `resource_kind` enum: add generic values (for example `space`, `station`, `vehicle`, `other`) in the migration; labels come from terminology.
- Preview mode (no database) must keep working: `src/lib/demo-data.ts` gets a business type too.
- Done when: profile resolution is tested for every preset and for overrides, the three payloads carry it, the gate passes. No visible wording change is required yet.

## Phase 3: Use the terminology everywhere

- Sweep every user-visible string that says patient, doctor, practitioner, clinic, practice, visit, dental, chair, operatory, clinical, and so on, and route it through the terms. Areas: `src/features/clinic/*` (dashboard, schedule, patients, doctors, team, follow-ups, messages, records, settings, setup, command palette, help dialog), `src/features/booking/*`, `src/app/**` pages (including `manage`, `portal`, `sign-in`, `access-denied`, error and not-found pages), notification and email text in `src/server/*` and `src/worker/*`, and calendar files.
- Navigation labels and page titles follow the terms (the "Patients" page reads "Clients" for a salon). URLs stay as they are.
- Feature flags gate both the UI and the API: with `records` off there is no Records nav item and the records routes refuse; same for recalls, dependents, date of birth, provider credentials.
- Settings gains a **Business profile** section: change business type (with a clear note about what changes), rename each term (singular and plural, with reset to default), toggle features. Owner and admin only; audited like other settings changes.
- Done when: switching a tenant to `real_estate` or `wellness` shows no healthcare word on any staff, booking, manage or portal screen (check in the browser at desktop and phone width), healthcare and dental tenants read exactly as before, and the gate passes.

## Phase 4: Setup from one link

- `/start` and `/setup` (`start-clinic-form.tsx`, `onboarding-choice.tsx`, `setup-workspace.tsx`, `src/lib/clinic-registration.ts`, `src/lib/clinic-setup.ts`, `src/server/clinic-registration.ts`): step one is choosing a business type from cards; later steps use that type's wording, placeholders and starter services. Replace the current `PracticeKind` (hospital / family / dental / other) with the registry.
- Finishing setup lands on a clear "Your booking link is live" moment: the hosted link `/book/[slug]`, copy and share actions, and the existing website options (link, embed, widget) presented as optional next steps. A business with no website must be able to take bookings within minutes.
- Optional per-service links (`/book/[slug]?service=…` preselecting a service) if the booking flow supports it cheaply; otherwise note it under "Open questions".
- Done when: a brand-new salon and a brand-new real-estate agency can each register, get a working link and receive a test booking without seeing clinic wording, and the gate passes.

## Phase 5: Custom booking forms

- Today `forms` holds one encrypted response per appointment against a `definitionKey` and version, but there is no way for a business to define a form. Build that.
- Schema: `form_definitions` (tenant, key, version, name, description, `fields` jsonb, active flag, applies to all services or a chosen set via a join table). Editing a published form creates a new version; old responses keep their version.
- Field types: short text, long text, email, phone, number, date, single choice, multiple choice, yes/no, consent checkbox. Each has label, help text, required, and options where relevant.
- Staff UI in Settings: a form builder with add, edit, reorder, remove, required toggle, live preview, and "attach to services". Offer a starter form per business type (for example intake for healthcare, property preferences for real estate, project brief for agencies).
- Booking flow: when the chosen service has an active form, show it as a step before confirmation. Validate on the server from the stored definition (never trust the client), store the response encrypted in the existing `forms` columns, respect idempotency.
- Staff see the answers on the appointment (`appointment-task.tsx`) under the same permission rules as other customer details; form answers must not leak into notifications.
- Preview mode supports forms with in-memory data.
- Done when: an owner can build a form, attach it to a service, a customer fills it while booking, staff read it on the appointment, with tests for definition validation, response validation and the API routes; the gate passes.

## Phase 6: Landing, docs and final check

- Landing page (`src/app/page.tsx`, `src/features/landing/platform-demo.tsx`), `embed-demo`, `sitemap`, `robots`, metadata: position Kalendr as the appointment system for any business. Show business types (healthcare and dental as one featured section among others). Follow the anti-references in `PRODUCT.md`: no gradients, no glass, no oversized metric cards.
- Rewrite `PRODUCT.md` for the wider audience (keep its structure, principles and accessibility bar). Update `docs/*` and `README` where they describe the product as clinic-only.
- Seed scripts (`scripts/seed-local-db.mjs`, `scripts/seed-demo-bookings.mjs`) can seed at least one non-healthcare business.
- Final: `pnpm check` (lint, typecheck, tests, build) passes. Walk the main journeys in the browser for one healthcare and one non-healthcare business: register, set up, share link, book with a form, manage booking, staff handles it. Record anything that does not work under "Open questions"; do not claim it works unless you saw it work.

## After the plan: business page, profiles and reviews

Built 11 to 12 November 2026 on the same branch, following [the discovery and reviews plan](DISCOVERY_AND_REVIEWS_PLAN.md), which holds the details and dated decisions. In short:

- **New pages.** `/b/[slug]` is the business page an owner shares ("Your page"); `/b/[slug]/team/[id]` is a person's profile; `/check-in/[token]` is where the confirmation QR points. `/book/[slug]` stays the booking flow and now also takes `?person=` and `?date=`.
- **Data.** Migration `0012_sad_ken_ellis.sql` adds `tenants.about`, `services.category`, `appointments.heard_from` and a `reviews` table with the same per-tenant row-level security as other tables.
- **Review rules.** Only the customer of a finished visit, from its manage link, within 60 days of the visit's end. 1 to 5 stars and an optional comment of up to 1,000 characters. The name shown is first name and last initial. Reviews publish straight away, and staff can hide them in Settings → Reviews. Hidden reviews never reach public pages. The average of every shown review appears with the count from the first review ("★ 4.8 · 5 reviews"). A review request is queued 2 hours after a visit is marked finished, once per visit, using the reminder channel and consent rules.
- **Extras.** An Add to calendar menu, a check-in QR card, and a one-tap "How did you hear about us?" question with a "How people found you" summary for staff.
- **New dependency.** `uqr` draws the QR code.

## Progress

- [x] Phase 1: Rebrand
- [x] Phase 2: Business types and terminology
- [x] Phase 3: Terminology everywhere
- [x] Phase 4: Setup from one link
- [x] Phase 5: Custom booking forms
- [x] Phase 6: Landing, docs, final check

## Open questions

- **Database checked on 11 November 2026 (resolved).** With PostgreSQL 17 from Homebrew: all 11 migrations apply from zero on a fresh database, and the 16 database integration tests pass there. The existing `.local-db` cluster (made before the rename, 4 migrations applied) was copied to `.local-db/backup-2026-11-11-before-kalendr`, then migrated to 11 with its 3 businesses intact. A salon was registered through `/start`, set up, given a booking form, and booked through `/book/kalendr-test-salon`; the answers were stored sealed and shown on the staff appointment screen. Three fixes came out of this: `scripts/local-db.sh` now grants `kalendr_portal_people` to the app role (missing before the rename too), finds Homebrew's keg-only PostgreSQL itself, and `scripts/seed-local-db.mjs` refuses to reseed a pre-rename cluster and runs a generic isolation check on it instead. Not checked: PostgreSQL 18 (the documented target), the patient portal and records screens in the browser, and `src/server/booking-forms.test.ts` fails when run with database environment variables set because it assumes preview mode.
- **Local database made before the rename (resolved).** `scripts/local-db.sh` now recognises a `.local-db` with the old `nira-local-cluster` marker and keeps using that cluster's `nira_local_*` roles, `nira_local` database and `NIRA_*` env keys; new clusters get the Kalendr names. The seed script and the integration-test guards accept both. Checked with `scripts/local-db.sh status` against the existing folder (accepted; the old script refused it). Not checked against a running Postgres, which is not installed here.
- **Ignored local folders** (`.next/`, `graphify-out/`, editor caches) may still hold the old name until they are rebuilt.
- **Second words.** Healthcare and dental keep "visit", "practitioner" and "practice" as second words beside "appointment", "doctor" and "clinic". Other types use their base words. An owner who renames the base word also replaces the second word.
- **Pages with no business.** These pages cannot know which business the visitor belongs to, so they now use neutral words for everyone, including healthcare:
  - portal sign-in ("Sign in to your bookings", "Staff? Sign in here");
  - the unknown-booking-link 404 ("This booking page is unavailable");
  - the unknown manage-link 404.

  The staff sign-in, forgot-password and reset-password pages, the general 404 and the error page now use neutral words too (resolved in Phase 6).
- **Messages with no business.** Server messages raised before the business is known now say "business" instead of "clinic" (for example "Business not found.", "No active business membership"). Healthcare users see that change.
- **Server activity log (resolved).** `src/server/staff-activity.ts` now describes role and permission changes in the business's own words.
- **Identity check in the portal.** Before showing a family member's documents, the portal asks for date of birth even when the date-of-birth feature is off. This only matters for a business with records on and date of birth off.
- **Command menu.** The command menu has no Records entry, so there was nothing to gate there.
- **Turbopack cache.** The dev server sometimes serves a stale bundle after many edits; restarting it fixes that.
- **No deep link in Settings.** Settings opens as a dialog with no deep link to a section, so the setup screen links to `/settings` generally rather than straight to the website code.
- **Per-service links (resolved).** `/book/[slug]?service=<service id>` opens the booking page with that service already chosen, and it stays chosen when the visitor picks a location or customer type that offers it. Settings → Customer page now has a "Copy link" button on each service, so owners never build the URL from an id.
- **Phase 4 test bookings ran in preview only.** The salon test booking went through all five steps and ended on the preview confirmation, but nothing was saved because there is no local database. Since Phase 6 the preview renames the sample services, team and resources for types other than healthcare and dental (a salon sees Haircut, Asha Mehta "Senior stylist", Station 1). Ids, kinds and durations are unchanged.
- **Station step after "No station needed".** Setup still asks for a station (or chair or room) even when the first service needs none. That flow is unchanged from before.
- **Booking forms were not checked against a database.** Form definitions, versions, service links and the sealed answers were tested through the routes in preview mode only. Migration `0010_booking_forms` (with row-level security on both new tables) was generated but never applied.
- **Production needs `KALENDR_RECORDS_KEY` for form answers.** Answers are sealed with the same key as records. Without it, a booking that carries a form fails with `records_unavailable` (503) in production.
- **Bookings made by staff skip the form.** Only the public booking page asks the business's questions. Staff-created bookings and reschedules do not.
- **Who can read answers.** Any staff member who can open the appointment can read its form answers. There is no separate permission yet. Each read is written to the activity log as `form_response.viewed`.
- **Preview form store is in memory.** In preview mode, forms and answers live in the dev server's memory and disappear when it restarts. Appointments that exist only in the browser's preview store have no answers to show.
- **Answers stay out of messages.** Form answers are never put in notifications, the outbox or the activity log. Staff read them on the appointment screen only.
- **Phase 6 was checked in preview only.** No Postgres runs on this machine, so `scripts/local-db.sh start/migrate/seed`, the new `cedar-hair` salon seed and the database integration tests were not run. A real owner signing up at `/start` and receiving a saved booking with answers was walked through in preview mode only (salon: register, setup, live link, starter form, booking with answers, Copy link; dental: words and sample unchanged).
- **Preview sample durations.** The renamed preview services keep the dental sample's durations and prices (for example Hair colour shows 30 minutes in preview, while setup suggests 120). Real businesses use their own.
- **Portal sample visits.** The preview customer portal (`portal-workspace.tsx`) still shows the dental sample's past visits. The portal's records parts only appear for healthcare and dental, but the sample visit names are not renamed for other types.
- **Preview staff screens flash sample clinic words.** In preview mode the staff screens are first rendered on the server with the default (clinic) words, then switch to the chosen type's words when the page loads, because the preview type lives in a browser cookie read on the client. Real businesses get their words from the server, so this affects preview only.
- **Starter form names from earlier types stay.** A preview business that switched type keeps forms made under the old type (for example a salon preview still lists "Before your visit"). Forms are never renamed automatically.
- **Finished visits still show "Before your visit".** The manage page for a finished visit still shows the "Before your visit" panel with "Attendance: Confirmation needed" above the review card. This predates the reviews work.
- **Sign-in placeholder.** The staff sign-in email field still shows "you@clinic.com" for every business type.
- **Review replies.** Owners can't reply to reviews yet; this was left for later on purpose.
