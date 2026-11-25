# Onboarding 2.0 (feature 11)

Goal: a first test booking within 10 minutes of registering, with nothing to read.

## Registration

`/start` starts with the account, then the business. Each screen is one short question, with no step counter:

1. **Create your account**: "Continue with Google", "Continue with Microsoft" (shown only when set up), or a work email.
2. **Check your email**: a 6-digit code (coss `OTPField`), checked as soon as the sixth digit is typed. Resend after 30 seconds, or use a different email.
3. **Choose a password** (email only; Google and Microsoft owners skip it and have no password).
4. **What kind of business?**: ten tiles. A tap moves on; a keyboard choice waits for Continue.
5. **Name your {salon, studio, clinic, ...}**: the business name, the owner's name (filled in from Google or Microsoft), "I take appointments myself" (on), and the booking link behind "change".

Place, street address and phone come later (the business profile, and the test booking asks for the owner's mobile number). `clinicRegistrationSchema` makes `phone`, `city` and `address` optional, takes the browser's time zone and a `template`, and makes `password` optional for Google and Microsoft owners.

**Proof of email before anything is made** (`src/server/sign-up-check.ts`). The code lives in `auth_verifications` as a keyed hash (10 minutes, 5 tries); `POST /api/public/sign-up` sends (`{action:"send"}`, rate limit `sign_up_code.ip`, Turnstile when the bot check asks) and checks it (`{action:"verify"}`). A right code, or a Google or Microsoft answer whose `email_verified` is true, gives a signed httpOnly cookie `kalendr_sign_up` (60 minutes). `POST /api/public/clinics` refuses without it (422 `email_not_verified`), checks that it names the same email, marks the owner's email verified, and clears it. No user or session exists until the business, the user and the membership are made together, so "no membership, no session" holds. `GET /api/public/sign-up` tells the page an earlier proof is still good, so a refresh or the return from Google carries on where it was.

**Google and Microsoft** (`src/server/sign-up-oauth.ts`) are a small OAuth leg of their own (state cookie `kalendr_sign_up_oauth`, PKCE): `/api/public/sign-up/oauth/{google,microsoft}` → provider → `/api/public/sign-up/callback/{provider}` → back to `/start`. It only reads the verified email and name. After the business is made the page calls Better Auth's normal social sign-in, which links the provider to the new account. **The real providers need these redirect URIs registered** next to Better Auth's: `<app>/api/public/sign-up/callback/google` and `<app>/api/public/sign-up/callback/microsoft`. Microsoft often leaves out `email_verified`; those owners are told to use the email code. Locally `KALENDR_DEV_OAUTH=true` uses the stand-in at `/api/dev-oauth/*`.

**Layout.** The page never scrolls (`h-dvh`): the header and the Continue bar are fixed, and only the question scrolls. On large screens the right half (`start-showcase.tsx`) is the owner's own booking page, built from what they have entered: the type fills in its services and prices, the name and initials appear at the top, "with {first name}" when they take bookings, and the link at the bottom. Nothing in it is sample data from another business. Below `lg` it is hidden. The rehearsal (`/start` with preview) starts at the kind of business and makes no requests.

## Templates (`src/lib/onboarding-templates.ts`)

Ten templates: general practice, dental, physiotherapy, salon, spa, barber, tutoring, consulting, fitness, and something else. Each names a broad business type (which sets the product's words and features), the business's own words (stylist, student, trainer, ...), typical services with lengths and prices, weekly opening hours, and one optional booking question. `registerClinic` runs `seedFromTemplate` (`src/server/onboarding/seed.ts`) in the registration transaction: services (with lengths, the first place and the owner on each), the owner's hours through the availability code, a booking form, the words in `tenants.terminology`. Reminder workflows come from the existing presets for the broad type (feature 5). A business that does not take bookings itself gets the services but no person and no hours, and the checklist and go-live check say so. The public page is bookable straight after registration.

`tenants.onboarding_started_at` is set only by this flow. Only those businesses get the checklist, the tour and the emails; businesses set up before it existed (and every seeded or API-made business) see none of it.

## The checklist (`src/lib/onboarding-steps.ts`, `src/server/onboarding/*`, `onboarding-checklist.tsx`)

Eight steps, each done, to do or skipped: confirm services, set hours, add your team, make a test booking, turn on reminders, add your logo and cover photo, share your link, connect payments (optional). A slim "Getting started" card on the dashboard shows the count, the next step as one button, and a ⋯ menu (all steps, the tour, sample data). Each step opens where it is done (a Settings section, the test booking panel, the share dialog). Services, hours and share link are ticked by the owner (or by sharing); team, reminders, brand and payments are found done from the business's own data; the test booking step is finished by making one. A skip stands until the step is really done. The card disappears when every step is done or skipped.

Progress lives in `onboarding_progress` (one row per finished or skipped step, `done_at` = the first time it was seen done). Leaving halfway and coming back shows the same next step because nothing is kept in the browser. The admin console reads `admin_onboarding_funnel` (counts per step and the median minutes from sign-up) at `GET /api/admin/onboarding`.

## The test booking

"Make a test booking" opens a side panel with the business's own `/book/<slug>` page (same origin, `?embed=1`) already filled in with the owner's name, email and mobile number (the existing booking-link prefill). The panel records when it opened and asks `POST /api/staff/onboarding/test-booking` every 3 seconds. The server finds the booking made since then with the owner's own email, flags it `is_test` (and the owner as a customer, if the booking created them and nothing else uses them), marks the step done, and returns how its confirmation is going (queued, on its way, sent, failed) from the `notifications` table. It does not touch the booking commit. "Remove test booking" calls `DELETE /api/staff/onboarding/test-data`.

`appointments.is_test` and `patients.is_test` are the flags. **Reports (feature 24) and any count of bookings must filter `not is_test`.** The onboarding code already does for "real bookings" (day-3 email, go-live check).

`kalendr_purge_test_rows(tenant)` is the one-click removal. It deletes the flagged bookings and the flagged customers that nothing else refers to, and it handles the three things that stop a plain delete: audit rows are append-only for the web role and one points at each booking, so the function (owner-run) unlinks them (`appointment_id` to null) rather than deleting them (**a decision for the reviewers**); a booking with a payment, a payment order or a visit record is money or a record and is never deleted, so it is retired (entered in error, its time freed) and counted; and consent records are append-only, so a customer who has one is kept and counted. It refuses to run for any business other than the one in scope. Every foreign key onto `appointments` and `patients` was checked against the scratch database.

## Sample data

"Add sample data" books up to eight appointments over the next week for customers named "(sample)", through the ordinary booking code with `notifyCustomer: false`, and flags them `is_test` and `is_sample`. A sample appointment is never planned for: the workflow engine reads it as if it did not exist (`loadAppointment` in `src/server/workflows/engine.ts`) and the fixed reminder sweep skips it, so no reminder, follow-up or review request is ever made for a customer who is not real. It needs a service, a person and hours. Removing is the same one click.

## Tour

Five stops on the real screens (schedule, new appointment, customers, messages, settings), as popovers anchored to the real controls (`product-tour.tsx`). It starts on the owner's first visit to the dashboard (only a business that registered through the guided flow has a tour state at all), can be closed at any point (which counts as seen) and is opened again from Help or the ⋯ menu. Where a control is not on screen (a phone with the menu closed) the stop shows in the middle.

## Go-live check

Before the owner copies the link: no services bookable online, no hours, no reminder channel working, phone or address missing, test data still present. Each says what is wrong and has a Fix button; the owner can still copy the link.

## Emails

Welcome at once (queued at registration), "finish setting up" at day 1 to an owner under half done who has not finished, "share your link" at day 3 while there is no real booking. The sweep (`onboarding-sweep`, every 15 minutes) queues them once each (fixed outbox keys); the handler checks the goal again just before sending. The day-11 "trial ends in 3 days" email is the billing sweep's (feature 14). These are Kalendr's mail to the owner, so they use the owner-notice path (`src/lib/owner-notices.ts`) rather than the customer workflow engine.

## Schema (migration `0056_onboarding_progress`)

`onboarding_progress`, `appointments.is_test`, `appointments.is_sample`, `patients.is_test`, `tenants.onboarding_started_at`; functions `kalendr_onboarding_tenants()` (worker only), `kalendr_purge_test_rows(tenant)`, `admin_onboarding_funnel(admin, days)`.

## Known limits

- The confirmation on a real phone needs a WhatsApp or text account; locally the worker sends to a capture server. The panel reports the provider's acceptance as "on its way" (the delivery report that moves it on can take a while or never come).
- The test booking is found by the owner's email. If the owner types a different email into the form the panel keeps waiting.
- Test and sample bookings show on the schedule like any booking; there is no "test" badge there yet.
- Removing a test booking does not remove an event already written to a connected calendar.
- Registration from one address is limited to 5 per 15 minutes (feature 9), so repeated browser-test runs from one address are refused until it passes.
- The tour assumes the sidebar or bottom bar links exist; a role that cannot see a screen gets a centred stop for it.
