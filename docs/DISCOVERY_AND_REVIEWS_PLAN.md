# Kalendr business page, profiles and reviews plan

Written 11 November 2026. Branch: `kalendr-generalization`. Follows `docs/BOOKING_EXPERIENCE_PLAN.md`; its guardrails (section 4), building blocks (section 5) and motion rules apply here unchanged.

**Goal.** Before booking, a customer can look a business over: what it offers, who works there, when they are free, what other customers said. Then they book in a tap or two. This works for any kind of business (dental, a hospital, a salon, a tutor), in the business's own words.

**Owner's decisions (11 November 2026)**

1. **One business's page**, not a directory across all businesses. Search and categories work inside that business.
2. **Real reviews.** Customers rate a completed visit; the business can hide a review. No made-up stars.
3. **Keep the current coss style.** The reference screens give the structure only, not their colours or shapes.
4. **Extras:** add to calendar, a QR code on the confirmation for check-in, and an optional "How did you hear about us?" question.
5. Left out: insurance or payment choice, messaging, video calls, a cross-business "Find care" directory.

**How to use this document.** Work through the phases in order. Tick the Progress list at the bottom and add notes under "Decisions made while building". Stop at **REVIEW STOP**.

---

## 1. What already exists (do not rebuild)

- The booking flow at `/book/[clinicSlug]`: one question per screen, service pictures, person tiles, time picker, details, confirmation, manage page (`docs/BOOKING_EXPERIENCE_PLAN.md` phases A–D).
- Staff profile data: `practitioners.bio`, `qualifications`, `experience_years`, `languages`, `photo_data_url`, `specialty`, `title`. Already in the public catalog (`src/server/public-catalog.ts`).
- Business logo and cover (`media_assets`), service pictures, `services.price_label`.
- An `.ics` calendar file: `GET /api/public/appointments/[token]/calendar`, linked from `booking-confirmation.tsx`.
- Appointment status `checked_in` and staff check-in in `appointment-task.tsx`.
- `?service=` preselect on `/book/[clinicSlug]`.

## 2. Reference screens and what we take from them

Structure only. No artwork, mascots, wording or brand colours.

| Reference | Take |
|---|---|
| "Find Care" home: search box, category circles, Continue | Business page: search inside the business, category chips built from the business's services |
| "Find Doctor": result count, cards with photo, rating, price, "4 slots available", a row of next days | Team list: person cards with photo, role, rating, starting price, next free days row |
| "Doctors Profile": rating and price chips, name, role, stats row (years, customers), tabs About / Reviews / Availability, sticky "Book now" | Person profile page with the same parts; stats only from real data |
| "Confirm booking?" sheet | Not needed: the wizard already has a final review line; skip a second confirm |
| "Appointment Booked!" with "Add to your Calendar" / "No thanks" | Confirmation: calendar menu (Google, Apple/.ics, Outlook) as the main action |
| Confirmation with address card, time card and QR code | QR card on the confirmation and manage page for check-in |
| "How did you hear about …?" one-tap list | Optional question on the confirmation |
| Pharmacy flow: "I don't mind" first, then people | Already done ("Anyone available") |

## 3. Decisions

1. **Address.** The business page lives at `/b/[clinicSlug]`; a person's profile at `/b/[clinicSlug]/team/[personId]`. `/book/[clinicSlug]` stays the booking flow so website buttons, embeds and `?service=` links keep working. Booking buttons on the new pages link to `/book/[clinicSlug]?service=…&person=…&date=…`.
2. **New preselects** on `/book/[clinicSlug]`: `person` (skips the provider step when that person offers the chosen service at the chosen location) and `date` (the time step opens on that date). Invalid values are ignored silently, as `service` is today.
3. **The owner's shared link becomes the business page.** Setup, Settings and the website-connection screen show `/b/[slug]` as "Your page" and keep `/book/[slug]` as "Direct booking link" for buttons and embeds.
4. **Categories** are the business's services grouped by a new optional `services.category` (free text, max 60). No category on any service: no chips. Owners set it in the service editor.
5. **Next free days** on cards come from the existing availability query, at most 7 days ahead, one request per page load per location (not per card), cached for 60 seconds. If it fails, cards show without the row.
6. **Reviews**
   - Who: the customer of an appointment with status `completed`, from the manage link, within 60 days after the visit, once per appointment. Editing is allowed within the same 60 days.
   - What: 1–5 stars (required), a comment up to 1,000 characters (optional). Shown name: first name and last initial.
   - Publishing: published straight away; staff with the settings permission can hide or show it again. Hidden reviews never leave the server on public pages.
   - Clinical business types (`isClinicalBusinessType`) show a hint under the comment box: "Please don't include health details."
   - Showing an average: only when there are at least 3 published reviews (for the business or the person); below that, show the count only ("2 reviews"). The average is rounded to one decimal.
   - Owner replies are left for later.
   - Asking for a review: when a visit is marked completed, queue a `review_request` notification (email) for 2 hours later, only if the customer agreed to reminders. Uses the existing `notifications` table and `semantic_key` `review:{appointmentId}`.
7. **"How did you hear about us?"** A new nullable `appointments.heard_from` (`search`, `social`, `friend`, `referral`, `walk_by`, `other`). Asked once on the confirmation as one-tap cards with "Skip". Saved through the manage token. Shown in the appointment details and as a small "How people found you" card on the dashboard (last 90 days).
8. **QR check-in.** The QR holds `{origin}/check-in/{manageToken}`. That page needs a signed-in staff member of the same business; it shows the appointment and a "Check in" button (never checks in by itself). A customer who scans it lands on their manage page instead. QR drawing uses the `uqr` package (MIT, no dependencies, about 10 kB): writing a QR encoder by hand is error-prone. This is the only new dependency.
9. **Add to calendar.** A `Menu` with Google Calendar (link), Apple Calendar and Outlook (both the existing `.ics` file), Outlook.com (link). Links are built in a pure function with tests.
10. **Search on the business page** filters services and team by name, specialty and category in the browser. No server search.

## 4. Screens

### Business page `/b/[clinicSlug]`

```
Phone (375)                          Desktop (1280)
┌───────────────────────────┐       ┌───────────────────────────────────────────────┐
│ [cover picture]           │       │ [cover, wide]                                 │
│ logo  Business name       │       │ logo  Business name  ★4.6 (31)    [Book now]  │
│ ★ 4.6 · 31 reviews        │       │ Address · Open today 9–6 · Call               │
│ Address · Open today 9–6  │       ├──────────────────────────────┬────────────────┤
│ [Book now]  [Call]        │       │ [Search services or people]  │ About          │
│ [Search…]                 │       │ (All) (Cleaning) (Implants)  │ Hours table    │
│ (All)(Cleaning)(Implants) │       │ Services: picture cards      │ Locations      │
│ Services: picture rows    │       │ Team: person cards + days    │ Reviews        │
│ Team: person cards        │       │                              │                │
│ Reviews  ·  About  ·  Hours│      │                              │                │
└───────────────────────────┘       └──────────────────────────────┴────────────────┘
```

- Header card: cover (none: no banner), logo or initials, name, rating line (decision 6), first location's address with a map link, today's hours, Book now (primary) and Call (outline).
- Search: `InputGroup` with a search icon; filters both lists; empty result uses `Empty`.
- Categories: `ToggleGroup` chips in a horizontal `ScrollArea`.
- Services: reuse `ServiceCard` in link mode (each card goes to `/book/…?service=`).
- Team: person cards (photo, name, role, rating, next free days row of `Button` chips going to `/book/…?person=…&date=…`). "See profile" link.
- Reviews: latest 3 with "See all" (`Drawer`/`Dialog`).
- About: business description (new optional `tenants.about`, max 1,500, edited in Business profile settings), hours per location, accessible entrance note.
- Embedded (`?embed=1`) is not supported for this page; it is for sharing.
- Metadata: title, description, Open Graph image from the cover. Indexable (`robots.ts` allow `/b/`).

### Person profile `/b/[clinicSlug]/team/[personId]`

- Back link to the business page, photo (large `Avatar`), name, role, chips for rating and starting price.
- Stats row (`Card`): years of experience, languages, number of reviews; each shown only when known.
- `Tabs`: About (bio, qualifications, services they offer as links) · Reviews (list, newest first, 10 at a time) · Availability (the existing `SlotPicker` read-only for the first service they offer, with a service `Select` when they offer several; tapping a time goes to `/book/…` with service, person and date).
- Sticky bottom "Book with {first name}" bar on phone, in the header from 768px.

### Confirmation additions

- Calendar menu as the first action.
- QR card: "Show this at the front desk" (the business's words), the QR at 200px, the reference code beneath.
- "How did you hear about us?" card below, one-tap, disappears with a thank-you after an answer or Skip. Not shown in preview mode or embeds.

### Manage page additions

- QR card while the visit is upcoming.
- Review card when allowed (decision 6): star `RadioGroup` (5 large buttons, labelled "1 star"…"5 stars"), `Textarea`, Send. After sending: the review with an Edit link.

### Staff

- Settings → new "Reviews" section: list with stars, comment, person, date, Hide/Show `Switch`; filter by person. Empty state.
- Service editor: Category field. Business profile: About field.
- `/check-in/[token]` page (decision 8).
- Dashboard: "How people found you" card.

## 5. Phases

### Phase 1 — Data

- `services.category`, `tenants.about`, `appointments.heard_from` (nullable, check constraint on the six values).
- `reviews` table: `id`, `tenant_id`, `appointment_id` (unique per tenant), `practitioner_id`, `service_id`, `rating` smallint 1–5, `comment` (≤1,000), `display_name` (≤60), `is_hidden` boolean default false, `created_at`, `updated_at`; foreign keys to appointments, practitioners, services within the tenant; index on (`tenant_id`, `practitioner_id`, `created_at`).
- `pnpm db:generate`, then add row-level security by hand as in `drizzle/0010_booking_forms.sql`.
- Server: `src/server/reviews.ts` (create/update by manage token, list public, summaries per business and per person, staff list and hide); unit tests with a fake store and an integration test against the local database (second business cannot read or hide another's reviews).
- Preview mode: a handful of sample reviews for the demo business in `src/lib/preview-sample.ts`, clearly sample data, only in preview.

**Done when:** migration applies on the local database; tests pass; the public catalog returns `category`, `about`, rating summaries; hidden reviews are never returned publicly (test).

### Phase 2 — Business page and profiles

Build the two pages in section 4, `person` and `date` preselects (with tests in `booking-flow.test.tsx`), the shared-link change (decision 3), `robots.ts`, `proxy.ts` if needed.

**Done when:** at 320, 375, 768 and 1280px with no sideways scrolling: a customer can go business page → person → time → booked; empty states (no pictures, no reviews, no categories, one person) look intentional; keyboard only works; lint, typecheck, tests pass.

### Phase 3 — Confirmation extras

Calendar menu with link-builder tests; QR card (confirmation and manage); `/check-in/[token]`; heard-from card, API (`PATCH /api/public/appointments/[token]` accepts only `heardFrom`), dashboard card.

**Done when:** each calendar link opens a correct event (checked by hand in Google and with the `.ics`); scanning the QR on a phone while signed in as staff opens the check-in page; a signed-out scan lands on the manage page; heard-from is saved once and shown to staff.

**REVIEW STOP 1**

### Phase 4 — Reviews end to end

Manage-page review card and API (`PUT /api/public/appointments/[token]/review`), review request notification, Settings → Reviews, reviews on the business page and profile, owner fields (Category, About).

**Done when:** complete a visit on the local database → the review card appears on the manage link → the review shows on the business page and profile → hiding it in Settings removes it from both; the average shows with the count from the first review (until 2026-11-22 it waited for 3 reviews); lint, typecheck, tests pass.

### Phase 5 — Write it down

Update `DESIGN.md` and `docs/KALENDR_PLAN.md` with the new pages and the review rules.

**REVIEW STOP 2**

## 6. Progress

- [x] 1 Data: columns, reviews table, row-level security
- [x] 1 Server reviews module and tests
- [x] 1 Preview sample reviews
- [x] 2 Business page
- [x] 2 Person profile
- [x] 2 `person` and `date` preselects
- [x] 2 Shared link change
- [x] 3 Calendar menu
- [x] 3 QR card and check-in page
- [x] 3 Heard-from question and dashboard card
- [ ] **Review stop 1**
- [x] 4 Review card on manage page
- [x] 4 Review request notification
- [x] 4 Settings → Reviews
- [x] 4 Category and About fields
- [x] 5 Documents
- [ ] **Review stop 2**

### Decisions made while building

(Add dated notes here.)

- 2026-11-11: Migration `0012_sad_ken_ellis.sql` adds `tenants.about`, `services.category`, `appointments.heard_from` (checked against the six answers) and `reviews` with row-level security. Applied to the local database; `scripts/local-db.sh check` still passes.
- 2026-11-11: Pure review rules live in `src/lib/reviews.ts` (display name, 60-day window, average from 3 reviews, input schema); database work in `src/server/reviews.ts`. `resolveManageToken` is now exported from `appointment-repository.ts` so reviews use the same token lookup.
- 2026-11-11: The window is measured from the appointment's end time, not from when staff marked it completed, because no completion time is stored.
- 2026-11-11: The public catalog now returns `clinic.about`, `service.category` and `ratings` (business and per team member). Staff loads (`includeInactive`) skip ratings.
- 2026-11-11: Preview: seven sample reviews in `src/lib/preview-reviews.ts`; sample dental services get categories, which other business types drop (their names are dental words). Reviews written in preview are kept in memory only.
- 2026-11-11: Integration tests on the local database need the legacy owner role (`nira_local_owner` / `nira_local`), since this cluster was made before the rename. The preview-only tests in `booking-forms.test.ts` fail when run with the database switched on; that is expected and unrelated.
- 2026-11-11: Opening hours on the business page come from the team's active working hours: each location opens at the earliest start and closes at the latest end that day. Preview shows Monday to Saturday, 9 to 6.
- 2026-11-11: "Next free" days search a week ahead with the fewest service searches that cover everyone at each location (asking for anyone free), cached for a minute per business. A failed search is left out, so the page still loads. Preview makes up sample days because its demo times are in the past.
- 2026-11-11: Today's date and weekday are worked out on the server in the business's time zone, so the page renders the same on server and browser.
- 2026-11-11: `/book/slug?person=id&date=YYYY-MM-DD` books with that person: locations narrow to theirs, services to theirs, and the people screen is skipped. The summary still lets the customer pick someone else when others offer the service. A person who doesn't offer the linked service, or a day with no free times, is ignored.
- 2026-11-11: Setup now shares `/b/slug` as "Your page", with the direct booking link beside it. The sidebar, Settings and command menu open the page; the website button and embed still use `/book/slug`. `robots.ts` allows `/b/`.
- 2026-11-11: Add to calendar is a menu on the confirmation and manage page: Google Calendar and Outlook.com open a filled-in event (with the manage link in the note); Apple Calendar and Outlook download the existing `.ics` file. The signed-in portal leaves the manage link out.
- 2026-11-11: The QR holds `/check-in/{token}`. Staff of the same business are sent to the existing appointment overview (`/appointments/{id}`), where they press Check in; it never checks in by itself. Everyone else, and preview, goes to `/manage/{token}`. `robots.ts` disallows `/check-in/`. The QR is drawn as an SVG with `uqr`.
- 2026-11-11: The QR card ("Show this when you arrive", with a short reference such as 2FF1-2E79) shows only for booked appointments, not requests, and on the manage page only until the appointment ends. It is hidden in preview and on the portal.
- 2026-11-11: "How did you hear about us?" is asked once on the confirmation (hidden in preview and embeds) and saved through the manage token's PATCH; a second answer doesn't overwrite the first. Staff see it as "Found you through" on the appointment, and as a "How people found you" popover in the Today header (last 90 days), next to Handover, so the queue keeps its full height.
- 2026-11-12: Marking a visit completed queues one review request (`appointment.review_request`, dedupe `review:{appointmentId}`) for 2 hours later. It goes by the existing reminder channel rules: email by default, text or WhatsApp only with consent. The worker skips it if the visit is no longer completed. Completing a visit twice doesn't send a second one.
- 2026-11-12: The review card ("How was your appointment?") shows on the manage link only for completed visits, not in the signed-in portal. Five tappable stars, an optional comment up to 1,000 characters, and an Edit button while the 60-day window is open. Clinical businesses see "Please don't include health details."
- 2026-11-12: About lives in Settings → Customer page with name, phone and address, not in Business profile, because the business profile save only takes type, words and features. Category sits in each service's editor there.
- 2026-11-12: Settings → Reviews lists every review, newest first, with a person filter and a "Shown on your page" switch. Hiding never changes what the customer wrote. In preview the switch changes the screen only; nothing is saved.
- 2026-11-12: Browser check on the local database: a test salon booking was completed as staff, reviewed on its manage link, showed on `/b/kalendr-test-salon` and the stylist's profile as "1 review" with no average, and was removed from both when hidden in Settings. Signing in on port 3002 needs the `kalendr-local-db-3002-browser-sign-in` launch entry; the plain one rejects sign-in from that origin.
- 2026-11-12: Phase 5: `DESIGN.md` has a new "Customer pages and reviews" section; `docs/KALENDR_PLAN.md` has "After the plan: business page, profiles and reviews" and three new open questions (the finished-visit "Before your visit" panel, the "you@clinic.com" sign-in placeholder, review replies).

## 7. Open questions for the owner

Each has a default; none blocks the work.

1. **Publish reviews straight away, or hold them for approval?** Default: straight away, with Hide.
2. **Owner replies to reviews?** Default: later.
3. **Review request by text message as well as email?** Default: email only (text messages cost money per message).
4. **A directory across all Kalendr businesses later?** The page is built so one can sit on top, but nothing is listed publicly across businesses now.
