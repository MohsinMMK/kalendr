# Kalendr by Khanect

[![CI](https://github.com/MohsinMMK/kalendr/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MohsinMMK/kalendr/actions/workflows/ci.yml)

**Live at [kalendr.khanect.com](https://kalendr.khanect.com).** Business sign-up opens once email delivery is set up.

Kalendr is a production-shaped appointment web application for small appointment-led businesses of any kind: clinics and dental practices, salons, spas and gyms, estate agencies, consultants and other professional firms, shops, tutors and coaching centres, and anything else that runs on bookings. It gives customers a calm self-service booking and manage-booking experience, and gives the business team one responsive workspace for approvals, schedules, resources, waitlists, arrivals, follow-ups, and booking forms.

This repository is intentionally a scheduling system, not a point-of-sale, billing platform, marketplace, or CRM. For healthcare and dental businesses it can also keep and share visit documents, but it is still not an EHR, diagnostic system, prescription system, emergency channel, or telemedicine product.

## Business types and words

An owner picks a business type at sign-up (`src/lib/business-types.ts`): Healthcare, Dental, Salon spa and fitness, Real estate, Professional services, Retail and shops, Education and tutoring, or Something else. The type sets:

- the words every screen, message and calendar file uses for customer, provider, business, appointment, service, resource and location (a clinic has patients, doctors and rooms; a salon has clients, stylists and stations; an estate agency has clients, agents and viewings);
- the starter services offered during setup;
- which features are on: records, follow-ups, booking for someone else, date of birth, provider qualifications, and the new-or-returning question. Records and the other medical features are on only for healthcare and dental by default.

Owners and admins can change the type, rename any word, and switch features in Settings > Business profile. Turning a feature off removes it from the screens and its API routes refuse requests. Internal names did not change: database tables, columns, routes and source folders keep their original clinic names (`patients`, `practitioners`, `tenants`, `/patients`, `/doctors`, `src/features/clinic/`).

## Included experience

- Setup from one link: `/start` asks for the business type, then the business, place, owner account and review; `/setup` adds the first service, resource, provider, assignment and hours, and ends on "Your booking link is live" with copy and share buttons and optional website steps.
- Mobile-first customer booking with service, provider, location, date, live slot, customer details, review, and confirmation stages. `/book/<slug>?service=<service id>` opens with that service already chosen.
- Custom booking forms in Settings > Booking forms: short text, long text, single choice, multiple choice, yes/no, date, number, email, phone and consent questions, attached to all services or chosen ones, with a starter form per business type. Editing a form creates a new version. Answers are validated on the server, stored encrypted with the records key, shown to staff on the appointment page, and kept out of messages.
- Private manage-booking links for confirmation, conflict-safe rescheduling, cancellation, and privacy-safe calendar export.
- A customer portal with one-time code sign-in. For healthcare and dental businesses with records on, it also shows the documents the practice has shared.
- A dayboard with a vertical schedule, action queues, provider and resource context, status transitions, customer lookup, and follow-up work.
- Hosted booking pages plus link, iframe, modal-loader, and backend API integration guidance for existing business websites.
- An interactive product tour with connected appointment actions, a schedule, customer search, and a booking example using fictional data.
- A typed PostgreSQL/Drizzle data model with tenant-aware access, audit events, notification outbox records, and database-level conflict protection.
- Better Auth integration boundaries, role-aware authorization helpers, validation, rate-limit and idempotency foundations, security headers, and privacy-first field design.
- Responsive PWA metadata, WCAG 2.2 AA-oriented components, keyboard-visible focus, reduced-motion support, loading states, and recovery states.

## Technology

- Next.js 16 App Router and React 19
- TypeScript with strict checking
- Tailwind CSS 4 with a documented Kalendr token system
- Base UI accessible tab behavior composed with the existing Kalendr components
- PostgreSQL and Drizzle ORM
- Better Auth
- Zod and React Hook Form
- Vitest and Testing Library
- Playwright CLI for final browser acceptance

## Local setup

Use Node.js 24 LTS and pnpm 11. The zero-dependency preview intentionally starts without an environment file:

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Development without `DATABASE_URL` uses deterministic preview data (a sample dental business; the business type chosen in preview is kept in a cookie and changes the words, not the sample services), so every core journey is runnable without external providers. Public preview data resets with the server; staff scheduling changes stay in the current browser session. Production writes require PostgreSQL and the configured services.

Useful prototype routes:

- `/` — product and integration overview
- `/start` — four stages: business type and name, location, owner account, and review; development preview rehearses the flow without creating an account
- `/setup` — resumable service, resource, provider, and working-hours setup ending on the live booking link; preview rehearses these choices without live writes
- `/book/indiranagar-dental` — customer booking (sample dental business)
- `/manage/demo-booking` — customer appointment management
- `/dashboard` — Today: dayboard and action queues
- `/schedule` — staff Day/Week/List schedule, guided booking, and reviewed availability planning
- `/appointments/new` — focused staff booking with customer, compatible opening, review, and confirmation
- `/patients` — customer operations (labelled with the business's word, such as Patients or Clients)
- `/follow-ups` — follow-ups and recalls queue (when the follow-ups feature is on)
- `/settings` — business profile, booking forms, team, activity, and website connection
- `/embed-demo` — existing-website integration example

## Database

For database-backed development, create ignored environment files, start PostgreSQL, export the same values for Drizzle, then apply the committed migration:

```bash
cp .env.example .env
cp .env.example .env.local
docker compose up -d postgres
set -a && source .env && set +a
pnpm db:migrate
```

Run `pnpm db:generate` only after an intentional schema change, then review the generated SQL before migration. The schema uses tenant-scoped identifiers (tables keep their original clinic names, such as `patients` and `practitioners`) and PostgreSQL exclusion constraints to prevent overlapping provider and resource bookings. Application checks improve feedback, but the database remains the final concurrency boundary.

Apply `0003_auth_account_compatibility.sql` before running the upgraded Better Auth runtime against an existing database. It makes historical account issuers optional and enforces provider/account uniqueness; duplicate provider identities stop the migration for review rather than being merged.

## Verification

Run the complete local acceptance command after setting up dependencies:

```bash
pnpm check
pnpm audit --prod
scripts/verify-postgres18.sh
```

`pnpm check` runs lint, strict type checking, unit/component tests, and a production build; the audit command verifies production dependency advisories. Browser acceptance is performed separately against the running app so that booking, management, staff actions, responsive behavior, and console output are checked as real user journeys.

The PostgreSQL acceptance script requires Docker and runs migrations, seeds, tenant isolation, and database integration tests in a disposable PostgreSQL 18.6 container. See [local database instructions](./docs/LOCAL_DATABASE.md).

## Environment variables

All secrets stay outside source control. See `.env.example` for the full contract.

- `POSTGRES_*`, `DATABASE_URL`, and `DATABASE_POOL_MAX` — local container and application database settings
- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `BETTER_AUTH_TRUSTED_ORIGINS` — authentication secret and exact origins
- `BETTER_AUTH_ALLOW_SIGNUP` and `BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION` — explicit staff identity policy gates
- `KALENDR_ALLOW_CLINIC_REGISTRATION` — explicit public business registration gate (the name keeps its original wording); production also requires verification delivery through the existing `EMAIL_FROM` and `RESEND_API_KEY` settings
- `NEXT_PUBLIC_APP_URL` — public application origin
- `DEPLOYMENT_VERSION` — immutable release identifier exposed to the runtime
- Email and SMS provider variables — optional until delivery providers are connected
- `KALENDR_RECORDS_KEY` and `KALENDR_FILE_STORE_DIR` — encryption key for records and booking form answers, and the records file store; production bookings that carry a form fail without the key
- `KALENDR_BOOKING_FRAME_ANCESTORS` — reviewed business website origins permitted to host the widget
- `KALENDR_PREVIEW_MODE` — development-only preview override; never enable it in production

## Documentation

- [Product contract](./PRODUCT.md)
- [Kalendr generalization plan](./docs/KALENDR_PLAN.md)
- [Delivery phases](./docs/PHASE_PLAN.md)
- [Research and decisions](./docs/PRODUCT_RESEARCH.md)
- [Onboarding source review and decisions](./docs/ONBOARDING_RESEARCH.md)
- [Local onboarding acceptance](./docs/verification/2026-10-09-onboarding.md)
- [Three-pass SaaS and onboarding refinement](./docs/verification/2026-10-10-saas-refinement.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Security and privacy](./docs/SECURITY.md)
- [Website integration](./docs/EMBEDDING.md)
- [Design system](./DESIGN.md)

## Production prerequisites

A live business rollout additionally requires authorized hosting and DNS changes, a production database, sender-verified email/SMS accounts, staff identity provisioning, backup and incident-response procedures, business-specific retention and cancellation policies, approved privacy/consent text, processor agreements, and jurisdiction-specific legal review. No external service is silently enabled by this repository.

## Contributing, security and licence

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Kalendr is source-available, not open source: all rights are reserved, as set out in [LICENSE](LICENSE).
