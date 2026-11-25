# Kalendr build plan: 55 features, end to end

Written 12 November 2026 for the `kalendr-generalization` branch. This folder is the plan. Features 1 and 35 are built; the rest are not.

Features 36–57 were added on 19 November 2026 from the Cal.com comparison in [CALCOM_GAP_ANALYSIS.md](CALCOM_GAP_ANALYSIS.md). Numbers 47 and 49 are unused. Specs for 36–43 are in [features-36-43.md](features-36-43.md). Specs for 44–57 are in [features-44-57.md](features-44-57.md). Every feature now has a written spec. The build order across parallel sessions is in [WAVES.md](WAVES.md).

## How to read this folder

| File | What it answers |
| --- | --- |
| `README.md` (this file) | How the whole system works from one end to the other, the list of features, and the order to build them |
| [CALCOM_GAP_ANALYSIS.md](CALCOM_GAP_ANALYSIS.md) | About 200 Cal.com features Kalendr lacks, each tagged with the feature that covers it; the source of features 36–57 and of the extra detail for 2–5, 16, 19, 20, 23, 26 and 34 |
| [STANDARDS.md](STANDARDS.md) | Which model and effort to run the build on, the code quality bar, and the checklist every feature must pass |
| [LIBRARIES_AND_APIS.md](LIBRARIES_AND_APIS.md) | Every library to install (with version), every outside service to connect, and every new environment variable |
| [features-01-10.md](features-01-10.md) | Messages that really arrive, sign-in and security |
| [features-11-22.md](features-11-22.md) | Onboarding, business setup and scheduling |
| [features-23-35.md](features-23-35.md) | Money, growth, and the platform itself |
| [features-36-43.md](features-36-43.md) | Scheduling engine to Cal.com's level |
| [features-44-57.md](features-44-57.md) | Trust, reach, and the platform around Kalendr |

Each feature has the same six parts: **Why it matters**, **Use** (libraries and services), **Where** (files, tables, routes), **How** (steps in order), **Done when** (the test that proves it), and **Needs** (features that must exist first).

Table and folder names keep their original clinic words (`patients`, `practitioners`, `src/features/clinic/`). On screen every business sees its own words. Do not rename tables.

---

## 1. Where Kalendr stands today

**Built and working locally**

- Staff sign-in with email and password, forgot and reset password, owner registration at `/start`, setup at `/setup`.
- Staff workspace: today, schedule, customers, team, follow-ups, waitlist, messages, records, reviews, settings, activity log.
- Public side: business page `/b/[slug]`, booking `/book/[slug]`, manage link `/manage/[token]`, QR check-in, add to calendar, custom booking forms, embeddable widget.
- Customer portal `/portal` with a one-time code sign-in.
- Database: PostgreSQL 18, every business isolated by row-level security, double-booking blocked by the database, an outbox table that queues every message.

**The four gaps that matter most**

1. **Nobody receives a message.** The worker only records what it would have sent. No email, WhatsApp or SMS leaves the system.
2. **No money moves.** There are no payments, deposits, invoices or subscription plans.
3. **Sign-in is password only.** No Google sign-in, no passkeys, no second factor, and customer codes work by email only.
4. **It cannot run in production yet.** No production worker, no shared rate limiter, no error tracking, no CI, and records are stored on local disk with one fixed key.

The 35 features close these gaps first, then add what the best booking products have.

---

## 2. How the system works, end to end

### 2.1 The parts

```
Customer's phone or browser          Staff browser (installable app)
        │                                      │
        ▼                                      ▼
┌──────────────────────── Next.js 16 web app ────────────────────────┐
│  Pages (src/app)      API routes (src/app/api)      proxy.ts (CSP)  │
│  public · staff · portal · admin · v1 (public API) · webhooks       │
└───────────────┬───────────────────────────────────┬────────────────┘
                │ every query runs inside            │ signed webhooks in
                │ withTenant(tenantId)               │ (payments, delivery status,
                ▼                                    │  calendar changes, WhatsApp replies)
┌──────────── PostgreSQL 18 ────────────┐            │
│ tenant tables with row-level security │◄───────────┘
│ outbox_events (the queue)             │
│ pg-boss schema (timers and schedules) │
└───────────────┬───────────────────────┘
                │ claims work with SKIP LOCKED
                ▼
┌──────────── Worker (src/worker) ───────────┐
│ sends email · WhatsApp · SMS · web push    │──► Resend, Meta, MSG91/Twilio
│ syncs calendars · renders invoice PDFs     │──► Google, Microsoft, Razorpay, Stripe
│ runs reminders, waitlist offers, retention │──► S3 storage, KMS, virus scanner
└────────────────────────────────────────────┘
```

Three rules hold the system together. Every feature follows them.

1. **The request never calls an outside service directly.** A request writes its change and an outbox row in one database transaction. The worker does the sending. If a provider is down, nothing is lost and nothing is sent twice.
2. **Every table that holds business data has `tenant_id` and a row-level security policy.** Code reaches it only through `withTenant`.
3. **Every change is checked twice:** by a Zod schema at the door and by a database constraint at the floor.

### 2.2 Sign-in, for each kind of person

| Person | How they sign in after this plan | Where the code lives |
| --- | --- | --- |
| **Owner** (new business) | Registers at `/start` with email and password or Google. Email is verified before the business goes live. | `src/server/clinic-registration.ts`, `src/lib/auth.ts` |
| **Staff** | Invited by the owner. Signs in with password, Google, Microsoft, a passkey or an emailed link. Owners and admins must add a second factor. A person who was not invited cannot create an account through Google. | `src/lib/auth.ts`, `src/server/staff-invites.ts` |
| **Customer** | No password, ever. A 6-digit code by WhatsApp, SMS or email, or the private link in their confirmation message. | `src/server/patient-auth.ts` |
| **Kalendr operator** (you) | A separate admin sign-in with a mandatory second factor. Can open a business only with a written reason, and every step is logged. | new `src/app/admin`, feature 15 |
| **Other software** | An API key per business with named permissions. | new `src/app/api/v1`, feature 34 |

After sign-in, the server looks up the person's membership, works out their role and permissions (`src/lib/permissions.ts`), and sets the tenant for the database transaction. The browser never tells the server which business it belongs to.

### 2.3 Onboarding: from sign-up to the first real booking

The target is **a first test booking within 10 minutes**.

1. **Register** at `/start`: business name, type, city, owner details.
2. **Pick a template.** The business type fills in starter services, words and features (already built in `src/lib/business-types.ts`).
3. **Checklist at `/setup`** with a progress bar that survives sign-out: hours, services, team, booking page, payments, messages, website.
4. **Bring existing data.** Upload a spreadsheet of customers and future bookings; preview before anything is saved (feature 12).
5. **Make it theirs.** Logo, colours, and their own web address (feature 13).
6. **Connect the outside world.** Calendar, payment account, WhatsApp. Each has a "skip for now".
7. **Try it.** A guided test booking shows exactly what the customer sees, including the message on their phone.
8. **Go live.** Share link, QR poster, website snippet, Google Business "Book" link.
9. **Trial ends** after 14 days into a paid plan or the free plan (feature 14).

### 2.4 Interaction: the life of one booking

1. Customer finds the business page (search, QR, WhatsApp link, website widget, or the AI assistant).
2. Picks a service, a person or "anyone available", and a time. The slot is **held** for 10 minutes.
3. Fills the booking form, pays a deposit if the service needs one.
4. The payment webhook confirms the booking. Confirmation goes out on WhatsApp, SMS or email with a calendar file and a manage link.
5. The staff schedule updates live. The booking appears in the person's Google or Outlook calendar.
6. Reminders go out by the business's own rules. The customer taps **Confirm** or **Reschedule** inside the message.
7. On the day: QR check-in or a walk-in token, live queue screen, visit, payment of the balance, invoice.
8. After: review request, follow-up reminder, package credit used, next visit offered.
9. If the customer cancels, the slot is offered to the waitlist automatically and the refund follows the business's policy.

### 2.5 Running it: who manages what

| Area | Who | What they use |
| --- | --- | --- |
| Day-to-day work | Reception, practitioners | Today, Schedule, Queue, Messages inbox |
| Business settings | Owner, admin | Settings, Team, Workflows, Payments, Plans |
| Money | Owner, billing role | Payments, Invoices, Reports |
| Privacy requests | Owner | Privacy centre: export, erase, consent history |
| The platform | Kalendr operator | Admin console, error tracking, queue health, billing |
| Releases | Developer | CI runs `pnpm check`, database tests and browser tests; `pnpm db:migrate` on every release |

---

## 3. The features

Size: **S** about a day, **M** two to four days, **L** about a week, **XL** more than a week. Sizes assume one focused build session per feature.

Some of the first 35 features gained detail from the Cal.com comparison. Each line marked **#N+** in [CALCOM_GAP_ANALYSIS.md](CALCOM_GAP_ANALYSIS.md) belongs in that feature's spec. Examples: round-robin weights and groups for feature 20, and workflow wait, filter and branch steps for feature 5.

### A. Messages that really arrive

| # | Feature | Impact in one line | Size |
| --- | --- | --- | --- |
| 1 | ✅ Production worker and scheduler (built 2026-11-12) | Turns the queue on for real; everything timed depends on it | M |
| 2 | ✅ Email delivery (built 2026-11-12) | Confirmations, codes and invites reach inboxes | M |
| 3 | WhatsApp delivery and inbox | India's default channel, with buttons and replies | L |
| 4 | SMS delivery (DLT) | Reaches people without WhatsApp or email | M |
| 5 | Message workflows | Reminders and follow-ups each business sets for itself; cuts no-shows | L |

### B. Sign-in and security

| # | Feature | Impact in one line | Size |
| --- | --- | --- | --- |
| 6 | ✅ Staff sign-in options and second factor (built 2026-11-19) | Google, Microsoft, passkeys, email link, 2FA, device list | L |
| 7 | ✅ Privacy centre (DPDP) (built 2026-11-19; notice wording needs a legal review) | Consent history, export, erasure, retention; required by May 2027 | L |
| 8 | ✅ Customer sign-in upgrade (built 2026-11-19; WhatsApp and text templates need approval) | Codes by WhatsApp and SMS, safer manage links | M |
| 9 | ✅ Rate limits and bot protection (built 2026-11-12) | Stops code spam, fake bookings and scraping | M |
| 10 | ✅ Protected storage (built 2026-11-12) | Cloud file storage, managed keys, virus scanning; unlocks real records | L |

### C. Onboarding and business setup

| # | Feature | Impact in one line | Size |
| --- | --- | --- | --- |
| 11 | ✅ Onboarding 2.0 (built 2026-11-20; a confirmation on a real phone needs a WhatsApp or text account) | First test booking in 10 minutes | L |
| 12 | Data import | Businesses switch without retyping their customer list | M |
| 13 | ✅ Branding and own web address (built 2026-11-20; a real certificate needs the hosting provider, real DNS needs a domain) | The booking page looks like the business, on its own domain | L |
| 14 | Plans and subscription billing | Kalendr earns money; limits by plan | L |
| 15 | Platform admin console | You can see, support and control every business safely | L |

### D. Scheduling power

| # | Feature | Impact in one line | Size |
| --- | --- | --- | --- |
| 16 | ✅ Google, Outlook and Apple calendar sync (built against fakes 2026-11-19; real accounts not yet connected) | No double-booking against personal calendars | XL |
| 17 | ✅ Repeating appointments (built 2026-11-20; WhatsApp needs the `series_confirmed` template approved at Meta) | Weekly therapy, classes, treatment plans in one step | M |
| 18 | ✅ Group sessions and classes (built 2026-11-20; seats are not charged yet, see `docs/group-classes.md`) | Many customers in one slot; opens education and fitness | L |
| 19 | Video visits | Remote appointments with a join link | M |
| 20 | ✅ Team routing (built 2026-11-20; see `docs/team-routing.md`) | "Anyone available", fair rotation, cover for leave | L |
| 21 | ✅ Smart waitlist (built 2026-11-20; WhatsApp offers need the `waitlist_offer` template approved at Meta) | Cancelled slots refill themselves | M |
| 22 | ✅ Walk-in queue and token screen (trunk queue plus door QR code and close-day, merged 2026-11-19) | The way most Indian clinics really run | L |

### E. Money

| # | Feature | Impact in one line | Size |
| --- | --- | --- | --- |
| 23 | Online payments, deposits and policies | Pay at booking; no-shows cost the customer, not the business | XL |
| 24 | Invoices, receipts and GST | Proper bills, refunds, day-end totals | L |
| 25 | Packages, memberships and coupons | Prepaid sessions and repeat income | L |

### F. Growth

| # | Feature | Impact in one line | Size |
| --- | --- | --- | --- |
| 26 | Reports and analytics | Revenue, no-show rate, busy hours, where customers come from | L |
| 27 | ✅ Customer profiles (CRM) (built 2026-11-20) | One timeline per customer, tags, segments, merge duplicates | L |
| 28 | ✅ Campaigns and win-back (built 2026-11-20; needs an email domain and approved WhatsApp and text templates) | Fills quiet days; brings lapsed customers back | M |
| 29 | ✅ Search and discovery (built 2026-11-21; needs a Google Business Profile of the owner's own to use the Book link) | Business pages rank on Google and share well | M |
| 30 | ✅ AI booking assistant (built 2026-11-20; website and WhatsApp, not text messages; real model not yet run, needs an Anthropic key) | Books by chat on WhatsApp and the web, day and night | XL |

### G. The platform itself

| # | Feature | Impact in one line | Size |
| --- | --- | --- | --- |
| 31 | ✅ Staff workspace upgrade (built 2026-11-12) | Drag to reschedule, real search, shortcuts, undo | L |
| 32 | Live updates, alerts and installable app | Screens update themselves; push alerts on the phone | L |
| 33 | ~~Languages~~ (dropped by the owner on 2026-11-12; not being built) | Hindi and regional languages for customers and staff | L |
| 34 | Public API and webhooks | Other software can connect; Zapier and Make work | L |
| 35 | ✅ Monitoring, browser tests and CI (built 2026-11-12) | You know when something breaks, before customers do | L |

### H. Scheduling engine to Cal.com's level (added 2026-11-19)

| # | Feature | Impact in one line | Size |
| --- | --- | --- | --- |
| 36 | ✅ Service setup 2.0 (built 2026-11-19) | Staff set buffers, notice, booking window and interval; several lengths with a price each; colours; hidden services; location choices; duplicate | L |
| 37 | ✅ Availability 2.0 (built 2026-11-19) | Named schedules, several ranges a day, date overrides, country holidays, out of office with forwarding, travel dates, a "why is this slot missing" checker | L |
| 38 | ✅ Booking limits (built 2026-11-19) | Caps per day, week, month or year; total booked time; a cap per customer; shared pools for a person, team or branch | M |
| 39 | ✅ Booking page 2.0 (built 2026-11-19) | Month, week and column layouts; the visitor's own timezone; 12/24-hour clock; profile and team pages | L |
| 40 | ✅ Booking questions 2.0 (built 2026-11-19) | Questions shown only for certain answers; hidden and locked prefilled fields; guests; email code check; phone-only booking | M |
| 41 | ✅ Approval rules (built 2026-11-19) | Approve always, only at short notice, or for free-mail addresses; reject with a reason; the customer proposes several times | M |
| 42 | ✅ Cancel and reschedule policy (built 2026-11-19) | Reasons saved; cut-offs; switch cancel or reschedule off; staff ask the customer to reschedule | M |
| 43 | ✅ Bookings list (built 2026-11-19; Repeating tab added 2026-11-20 with feature 17) | Tabs, saved filters, bulk actions, reassign, no-show for staff and customer, history per booking | L |

### I. Trust, links and conversion (added 2026-11-19)

| # | Feature | Impact in one line | Size |
| --- | --- | --- | --- |
| 44 | Spam protection | Blocklist, report a booking, review queue, silent refusal | M |
| 45 | Special links | Single-use, expiring and limited-use links; one link for two people together | S |
| 48 | Service templates | One admin-owned service copied to many staff or branches, with locked fields | M |
| 50 | Calendar entry wording | Title and description templates; hide notes or details; reply-to address | S |
| 51 | Ratings and feedback | Rating link after the visit; score on the booking; satisfaction in reports | M |
| 52 | ✅ Embeds and conversion (built 2026-11-20; pixels and the live Meta, Google and Plausible scripts are not tested against the providers) | Embed builder with preview, full embed events, redirect after booking, analytics pixels, short links | M |
| 56 | ✅ Staff notifications (built 2026-11-20; out-of-office forward and form-received events have no trigger yet) | Each person chooses email, in-app or push per event; daily digest | M |

### J. Teams, enterprise and ecosystem (added 2026-11-19)

| # | Feature | Impact in one line | Size |
| --- | --- | --- | --- |
| 46 | ✅ Routing forms (built 2026-11-21; public form not framable, plain branding) | Questions first, then the right service or person; routing by staff attributes; trace and funnel report | XL |
| 53 | Enterprise and teams | Sub-teams, SSO (SAML and OIDC), user provisioning (SCIM), verified domains, custom roles, staff attributes, audit-log screen | XL |
| 54 | ✅ AI and developer access (built 2026-11-20; API keys only, no OAuth; no one-time-code booking path) | An MCP server so AI assistants can book through Kalendr; drop-in booking components | M |
| 55 | App marketplace | One place to connect apps: Slack, CRM sync, analytics, WordPress | XL |
| 57 | Browser extension | Share booking links and see today's list from the browser | S |

---

## 4. Build order

Numbers above are for finding a feature. **This is the order to build in.** Each stage leaves the product working and better than before.

| Stage | Build | Why now |
| --- | --- | --- |
| **0. Safety net** | 35 (CI and browser tests first, monitoring next), 1, 9 | Everything after this is safer and the worker runs for real |
| **1. Reach people** | 2, 3, 4, 5 | The product's main promise. Nothing else matters if messages do not arrive |
| **2. Trust** | 6, 8, 10, 7 | Needed before real customer data and before opening registration |
| **3. Earn** | 23, 24, 14 | Businesses get paid; Kalendr gets paid |
| **4. Win new businesses** | 11, 12, 13, 15 | Open public registration with confidence |
| **5. Schedule anything** | 16, 20, 17, 21, 18, 19, 22 | Matches and passes Cal.com, Fresha and Practo on scheduling |
| **6. Grow** | 26, 27, 28, 25, 29 | Keeps businesses and helps them grow |
| **7. Stand out** | 32, 31, 34, 30 (33 dropped) | Polish, reach, and the AI assistant on top of a solid base |
| **8. Cal.com's engine** | 36, 37, 40, 42, then 38, 39, 41, 43 | The core scheduling rules and screens Cal.com has and we lack |
| **9. Trust and conversion** | 44, 45, 48, 50, then 51, 52, 56 | Fewer fake bookings, more finished bookings, clearer messages |
| **10. Teams and ecosystem** | 46, 53, 54, 55, 57 | Bigger businesses and outside tools |

Stages 0 and 1 are not optional and not reorderable. From stage 2 on, the order inside a stage can change.

Stage 8 needs no outside accounts, so it can start any time after stage 1 and run alongside stages 2–5. Stage 9 needs email (2) and workflows (5) for 50, 51 and 56, and the API (34) for 52. Stage 10 needs team routing (20), the API (34) and the platform admin console (15).

---

## 5. What you (the owner) must provide

The build can write and test all the code with test keys. Going live needs these accounts. Start the slow ones now.

| Needed for | What to get | How long it takes |
| --- | --- | --- |
| Email (2) | Resend account, a sending domain with DNS records | An hour |
| WhatsApp (3) | Meta Business account, verified business, a phone number, approved templates | Days to two weeks |
| SMS (4) | MSG91 account, DLT registration as a Principal Entity, approved headers and templates | One to three weeks |
| Sign-in (6) | Google Cloud OAuth client, Microsoft Entra app registration | An hour each; Google review takes longer if calendar scopes are requested |
| Bot protection (9) | Cloudflare Turnstile site key | Minutes |
| Storage and keys (10) | S3-compatible bucket and a KMS key (AWS Mumbai region, or Cloudflare R2 plus a KMS) | An hour |
| Payments (23, 14) | Razorpay account with KYC; Stripe account for customers outside India | Days |
| Calendar (16) | Google OAuth verification for calendar scopes, Microsoft app permissions | Google verification can take weeks |
| Video (19) | Daily account | Minutes |
| AI (30) | Anthropic API key | Minutes |
| Monitoring (35) | Sentry project | Minutes |
| Hosting | A host for the web app, a host for the worker, managed PostgreSQL 18 with backups | A day |
| Legal | Privacy notice, terms, consent wording, a named grievance contact (DPDP) | With a lawyer |

Kalendr makes no compliance claim. Features 7 and 10 build the controls; a lawyer confirms they are enough.

---

## 6. Where the ideas came from

Checked against the open-source and commercial products below. The notes say what Kalendr takes from each.

| Product | What we take |
| --- | --- |
| **Cal.com** (open core until April 2026; now closed, with the community fork Cal.diy under MIT) | Features 36–57 (see [CALCOM_GAP_ANALYSIS.md](CALCOM_GAP_ANALYSIS.md)), slot holds with an expiry, workflow engine with triggers and steps, round-robin by priority and weight, calendar cache with push invalidation, signed webhooks with a version |
| **Easy!Appointments**, **LibreBooking**, **Odoo Appointments** | Calendar sync, resources with capacity, per-customer limits |
| **Medplum** | Hold then book in one transaction, with buffers |
| **OpenEMR**, **Frappe Health** | Repeating visits, facilities, leave blocking the schedule |
| **Fresha**, **Booksy**, **Square Appointments**, **Acuity** | Deposits, no-show and late-cancel policy, packages and memberships, reports, campaigns |
| **Jane** | Video visits, automatic review requests, client app |
| **Practo Ray** | Token queue and India-first practice habits |
| **pg-boss**, **graphile-worker**, **Inngest** | Postgres-only job queue; cancelling a scheduled send when the booking changes |
| **Novu** | A preference centre per channel |
| **Documenso**, **Formbricks** | Signed consent with an audit trail; survey before review request |

Two lessons shaped the plan. Cal.com has put its embeddable component kit into maintenance mode, so this plan does not build an SDK and keeps the simple widget. Reserve with Google is open only to approved partners and ABDM certification takes months, so both stay out of the 35; feature 29 uses the Google Business "Book" link instead, and the ABHA number can be collected as an ordinary form field.
