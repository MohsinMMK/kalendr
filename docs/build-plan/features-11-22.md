# Features 11–22: Winning businesses, and scheduling anything

Read `STANDARDS.md` first. Each feature has six parts: **Why it matters**, **Use**, **Where**, **How**, **Done when**, **Needs**.

---

## C. Winning new businesses

### 11. Onboarding 2.0

**Size:** L

**Why it matters.** A new owner decides in the first ten minutes whether to stay. Today setup ends at a working page but nothing shows the owner what to do next, proves the system works, or brings them back if they leave halfway. The goal: **a first test booking within 10 minutes of registering.**

**Use.** No new library by default. Build the tour from the coss Popover. `driver.js` 1.11.0 only if that proves too limiting. `posthog-js` and `posthog-node` are optional, and only with consent.

**Where.**

| Change | Path |
| --- | --- |
| Progress | new table `onboarding_progress` (tenant, step key, done at, skipped at) |
| Steps and templates | new `src/lib/onboarding-steps.ts`; templates in `src/lib/business-types.ts` and `src/lib/clinic-setup.ts` |
| Setup screens | `src/features/clinic/setup-workspace.tsx`, `onboarding-choice.tsx`, `start-clinic-form.tsx` |
| Checklist card | new `src/features/clinic/onboarding-checklist.tsx`, shown on the dashboard |
| Tour | new `src/features/clinic/product-tour.tsx` |
| Routes | new `src/app/api/staff/onboarding/route.ts` |
| Emails | onboarding series as workflows (feature 5) |

**How.**

1. Registration asks only four things: name, email, business name, business type. Everything else comes later.
2. On registration, fill the account from a **template for the business type**: typical services with durations and prices, opening hours, a booking form, reminder workflows, and the business's own words. The owner edits rather than starts from blank. Add templates for dental, general practice, physiotherapy, salon, spa, barber, tutoring, consulting and fitness.
3. The checklist has eight steps, each one click from where it is done, each showing done, to do, or skipped:
   1. Confirm your services
   2. Set your hours
   3. Add your team
   4. Make a test booking
   5. Turn on reminders
   6. Add your logo and colour
   7. Share your booking link
   8. Connect payments (optional)
4. **Step 4 is the important one.** "Make a test booking" opens the public page in a side panel, pre-filled with the owner's own contact, and the owner watches the booking land on their schedule and the confirmation reach their phone. Mark the appointment as a test so it is left out of reports and can be removed in one click.
5. Offer "Add sample data" for owners who want to explore first: a week of clearly labelled sample appointments and customers, removable in one click.
6. The tour is five short stops on the real screens (schedule, new appointment, customers, messages, settings). It can be closed at any point and reopened from Help.
7. Every empty screen says what it is for and has one button to add the first item.
8. Go-live check: before the owner shares the link, show a short list of anything that would embarrass them (no services bookable online, no hours set, no reminder channel working, test data still present).
9. Onboarding emails through the workflow engine: welcome at once; "finish setting up" at day 1 if under half done; "share your link" at day 3 if no real booking; "your trial ends in 3 days" at day 11. Each stops when its goal is met.
10. Record step completion times so the admin console (15) can show where owners drop off.

**Done when.** A new owner goes from the registration form to seeing their own test booking on the schedule, with a confirmation on their phone, in under 10 minutes without reading any help. Leaving halfway and returning resumes at the same step. The day-1 email is not sent to an owner who has finished.

**Needs.** Features 2 and 5. Feature 3 for the phone confirmation.

---

### 12. Data import

**Size:** M

**Why it matters.** No business starts from zero. They have customers in a spreadsheet or another tool, and retyping 2,000 names is the reason most stop. A safe import turns a week of work into ten minutes.

**Use.** `papaparse` 5.7.1, `libphonenumber-js`.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `import_jobs` (kind, file, mapping jsonb, status, counts, started by), `import_rows` (job, row number, status, error, created id) |
| Server | new `src/server/imports/parse.ts`, `map.ts`, `validate.ts`, `commit.ts` |
| Routes | new `src/app/api/staff/imports/route.ts`, `[id]/route.ts`, `[id]/commit/route.ts`, `[id]/errors/route.ts` |
| Screen | new `src/features/clinic/import-workspace.tsx`, opened from Customers and Settings |
| Worker | `import-commit` handler |

**How.**

1. Three kinds: customers, services, and future appointments. Provide a sample CSV for each.
2. Step 1, upload: accept CSV up to 10 MB. Store the file encrypted in the file store.
3. Step 2, match columns: guess the mapping from header names ("Mobile", "Phone No", "Contact" → phone) and let the owner correct it. Show the first five rows as they will be saved.
4. Step 3, check (dry run): validate every row with the same Zod contracts the API uses. Normalise phone numbers; parse dates in the format the owner picks; flag duplicates by phone or email, both inside the file and against existing customers. Show totals: ready, will update, will skip, has errors.
5. Step 4, import: the worker commits in batches of 200 inside tenant transactions, writing `import_rows` as it goes so progress is real. A failure in one row never blocks the others.
6. Duplicates follow the owner's choice: skip, or fill in blanks only. Never overwrite existing details silently.
7. Imported customers get **no messaging consent** by default. A column can supply it, and the owner must tick a box confirming they hold that consent.
8. Appointment import: match customer, service and staff member by name; refuse rows that would clash with an existing booking and list them. Imported appointments send no confirmation unless the owner asks.
9. Offer a downloadable error file: the original rows that failed, with a reason column, ready to fix and re-upload.
10. Undo: for 7 days, an import can be reversed, removing only rows it created that have not been used since.

**Done when.** A 2,000-row customer file with messy phone formats and 50 duplicates imports in under two minutes, the totals match, the 50 are skipped, and the error file contains exactly the bad rows. Undo removes the imported customers and leaves earlier ones alone.

**Needs.** Features 1 and 10.

---

### 13. Branding and own web address

**Size:** L

**Why it matters.** Owners want customers to see their brand, not Kalendr's. A booking page on `book.theirbusiness.com` in their colours is the feature that makes a business feel the product is theirs, and it is a natural reason to upgrade plans.

**Use.** `node:dns/promises`. TLS certificates come from the host (Caddy on-demand TLS, or Vercel or Cloudflare's custom-hostname API).

**Where.**

| Change | Path |
| --- | --- |
| Brand settings | new `brand` jsonb on `tenants` (logo asset, accent colour, cover image, corner style, hide Kalendr badge) |
| Theme | new `src/lib/brand-theme.ts`; applied in `src/app/b/[clinicSlug]`, `src/app/book/[clinicSlug]`, `src/app/manage/[token]`, emails |
| Domains | existing `tenant_domains` table |
| Allowed embed sites | new table `tenant_embed_origins` (tenant, origin, added by) |
| Host lookup | `src/proxy.ts` |
| Routes | new `src/app/api/staff/brand/route.ts`, `domains/route.ts`, `domains/[id]/verify/route.ts`, `embed-origins/route.ts`, and `src/app/api/internal/domain-check/route.ts` |
| Screens | `src/features/clinic/patient-page-settings.tsx`, `website-connection-workspace.tsx` |

**How.**

1. Brand: the owner picks a logo, one accent colour and a cover image. Turn the accent into a full set of CSS variables, and **check contrast**: if text on the chosen colour would be hard to read, pick the darker or lighter text automatically and tell the owner. Show a live preview on phone and desktop beside the controls.
2. Apply the brand to the public page, the booking flow, the manage page, the portal header, emails, invoices and the QR poster. Staff screens keep Kalendr's own look.
3. Own web address, in four plain steps on screen:
   1. The owner types `book.theirbusiness.com`.
   2. Kalendr shows two DNS records to add: a `CNAME` to `KALENDR_CNAME_TARGET`, and a `TXT` record with a one-time token (stored hashed in `verificationTokenHash`).
   3. "Check now" looks up both with `node:dns/promises`. A job rechecks every few minutes for 72 hours.
   4. On success, set `verifiedAt` and the address goes live.
4. `src/proxy.ts`: when the request's host is not Kalendr's own, resolve it to a tenant through a cached `SECURITY DEFINER` lookup and rewrite to that business's public pages. Unknown hosts get a plain 404. Staff sign-in stays on Kalendr's own address only.
5. Certificates: the host asks `/api/internal/domain-check?domain=…` before issuing one; answer yes only for verified domains. This stops anyone pointing a random domain at Kalendr and getting a certificate.
6. Recheck verified domains daily; warn the owner if the records disappear, and stop serving after 7 days.
7. Embedding: save the sites allowed to show the booking widget in `tenant_embed_origins`, and build `frame-ancestors` per business from that list (with feature 9). This closes the long-open "saved website plans and origin approval" gap. The website-connection screen saves the origin when it generates the snippet.
8. Plan limits (feature 14): own web address and hiding the Kalendr badge are paid features.

**Done when.** A business's page loads on its own address with a valid certificate, in its colours, and a yellow accent gets dark text automatically. An unverified domain is refused a certificate. The booking widget loads on a saved site and is blocked on any other.

**Needs.** Feature 9. Hosting that supports custom hostnames.

---

### 14. Plans and subscription billing

**Size:** L

**Why it matters.** This is how Kalendr earns. Without plans, limits and billing there is no business, and message costs (WhatsApp and SMS are charged per message) would be unbounded.

**Use.** `razorpay` 2.9.8 (Subscriptions with UPI Autopay) for India, `stripe` 23.1.0 elsewhere. Called directly, not through `@better-auth/stripe`.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `plans` (not tenant-scoped: key, name, price, limits jsonb), `tenant_subscriptions` (plan, status, period end, trial end, provider ids), `billing_events` (provider event id unique, type, payload), `usage_counters` (tenant, period, metric, count), `platform_invoices` |
| Limits | new `src/lib/entitlements.ts`, new `src/server/entitlements.ts` |
| Billing server | new `src/server/billing/razorpay.ts`, `stripe.ts`, `subscriptions.ts` |
| Webhooks | `src/app/api/webhooks/razorpay`, `stripe` (platform events) |
| Routes | new `src/app/api/staff/billing/*` |
| Screens | new Settings section "Plan and billing"; an upgrade dialog reused everywhere |
| Enforcement | `src/server/staff-context.ts` loads entitlements with the context |

**How.**

1. Define plans as data. A starting point to adjust with the owner:

   | | Free | Starter | Growth | Scale |
   | --- | --- | --- | --- | --- |
   | Staff calendars | 1 | 3 | 10 | Unlimited |
   | Locations | 1 | 1 | 3 | Unlimited |
   | Bookings per month | 50 | Unlimited | Unlimited | Unlimited |
   | Email | Yes | Yes | Yes | Yes |
   | WhatsApp and SMS | No | Included amount, then pay per message | Larger amount | Largest |
   | Online payments | No | Yes | Yes | Yes |
   | Own web address, no badge | No | No | Yes | Yes |
   | Calendar sync, reports, API, assistant | No | Limited | Yes | Yes |

2. One function answers every question: `can(context, "feature")` and `withinLimit(context, "metric")`. **Enforce on the server in the same place permissions are checked**; hide or badge the control on screen. The check throws `ApiError` `plan_limit` with the name of the plan that unlocks it, and the screen opens the upgrade dialog.
3. Every new business gets a 14-day trial of Growth, no card needed. At the end it drops to Free unless a plan was chosen; nothing is deleted, extra staff calendars become read-only.
4. Checkout: Razorpay Subscriptions for businesses in India (UPI Autopay or card), Stripe Checkout elsewhere, chosen by the business's country.
5. Webhooks keep `tenant_subscriptions` current: activated, charged, failed, paused, cancelled. Dedupe on the provider's event id in `billing_events`.
6. Failed payment: retry by the provider's schedule, email the owner at each failure, show a banner to owners only, keep full service for 7 days, then drop to Free.
7. Usage: count messages by channel and category in `usage_counters` as they are sent. Show a meter in Settings. At 80% and 100% of the included amount, tell the owner. Past it, either stop marketing messages or bill overage, by the owner's choice. **Appointment confirmations and reminders are never silently stopped.**
8. Kalendr's own invoices to businesses carry 18% GST with Kalendr's GSTIN and the business's GSTIN when given. Number them gaplessly. Build this on the invoice code from feature 24 if that is done; otherwise use the provider's invoices for now.
9. Changing plan mid-period: upgrades apply at once with a pro-rated charge; downgrades apply at the period end.
10. An owner can cancel in two clicks, and export their data first (feature 7).

**Done when.** In test mode: a trial business subscribes with UPI, the webhook activates the plan, and a fourth staff calendar on Starter is refused by the server with an upgrade prompt. A failed renewal shows the banner and drops the plan after 7 days. The message meter matches the number of WhatsApp messages sent.

**Needs.** Features 1, 2 and 6. A Razorpay account with Subscriptions enabled, and a Stripe account.

---

### 15. Platform admin console

**Size:** L

**Why it matters.** Once real businesses are on Kalendr, someone must be able to answer "why did this customer not get a reminder?" without opening the database. Support, billing fixes, abuse handling and gradual feature release all need a safe operator's view.

**Use.** No new library.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `platform_admins` (user, role: support, billing or super; added by), `impersonation_sessions` (admin, tenant, reason, started, ends, ended), `platform_audit_events` |
| Route group | new `src/app/admin/*` and `src/app/api/admin/*` |
| Context | new `src/server/admin-context.ts` |
| Cross-tenant reads | `SECURITY DEFINER` functions, one per question, in a migration |
| Banner | `src/features/clinic/clinic-shell.tsx` |

**How.**

1. Operators are ordinary better-auth users listed in `platform_admins`. A second factor is mandatory with no exception. The console is served only on Kalendr's own address, and can be limited to an allow-list of IPs.
2. `getAdminContext` is separate from `getStaffContext`. No staff route accepts an admin session and no admin route accepts a staff session.
3. Cross-tenant data comes only from named functions such as `admin_list_tenants`, `admin_tenant_health`, `admin_find_notification`. Each returns the least it can: counts and statuses, not customer names. The runtime role still cannot read across tenants by itself.
4. Screens:
   - **Businesses:** search, plan, status, sign-ups by day, last active, onboarding step reached.
   - **One business:** plan and billing state, usage, staff count, message delivery health, recent errors, feature switches.
   - **Messages:** find a message by id or appointment id and see every attempt and provider response.
   - **Worker:** queue depth, oldest pending item, dead letters with "retry", heartbeats.
   - **Abuse:** businesses with unusual volume, blocked sign-ups, suppression lists.
5. Impersonation ("View as this business") is the only way to see customer data, and it is tightly bounded: the operator must type a reason; the session lasts 30 minutes; a bright banner shows on every screen; it is **read-only unless the operator has the super role and asks for write access**; every page viewed is recorded; and the business owner can see the list of support sessions in their own Activity log.
6. Feature switches per business use the existing `tenants.features`, with an added `rollout` layer: off, on for listed businesses, on for a percentage, on for all.
7. Actions: extend a trial, change plan, pause a business (public pages show a neutral notice), resend a verification email. Each records a reason in `platform_audit_events`.
8. Never show secrets, tokens, message bodies or record contents in the console.

**Done when.** A support operator finds why a reminder was not delivered in under a minute without seeing the customer's name. Viewing as a business shows the banner, cannot save changes, ends after 30 minutes, and appears in that business's Activity log. A staff member who guesses `/admin` gets a 404. A new feature is switched on for one business only.

**Needs.** Features 1, 6 and 35.

---

## D. Scheduling anything

### 16. Google, Outlook and Apple calendar sync

**Size:** XL (three sessions)

**Why it matters.** Staff live in their own calendars. If a stylist's dentist visit in Google Calendar does not block their Kalendr slots, they get double-booked and stop trusting the system. This is the most requested feature in every scheduling product studied.

**Use.** `googleapis` 189.0.0, `@microsoft/microsoft-graph-client` 3.0.7, `tsdav` 2.5.0.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `calendar_connections` (staff member, provider, account email, tokens encrypted, status), `calendar_selections` (connection, calendar id, block availability yes/no, write here yes/no, sync token, channel id, channel expires at), `external_busy` (staff member, starts, ends, source event id; **no titles stored**), `appointment_event_links` (appointment, connection, event id, etag) |
| Adapters | new `src/server/calendars/provider.ts`, `google.ts`, `microsoft.ts`, `caldav.ts`, `fake.ts` |
| OAuth routes | new `src/app/api/staff/calendars/connect/[provider]/route.ts`, `callback/[provider]/route.ts` |
| Webhooks | new `src/app/api/webhooks/google-calendar/route.ts`, `microsoft-graph/route.ts` |
| Availability | `src/server/appointment-repository.ts` and the availability query |
| Worker | handlers `calendar-sync`, `calendar-write`, `calendar-renew` |
| Screen | `src/features/clinic/profile-workspace.tsx`: "My calendars" |

**How.**

*Session 1: read busy time.*

1. Each staff member connects their own calendar from their profile. Ask for the narrowest scopes that work. Store refresh tokens encrypted (feature 10). Verify the OAuth `state` value against the session.
2. After connecting, list their calendars and let them tick which ones block availability.
3. First sync: read events from now to the furthest bookable date and store **only start, end and an event id** in `external_busy`. Keeping titles out means a personal appointment never appears in Kalendr.
4. Treat `external_busy` as a cache. The availability query subtracts it like a schedule block. Do not call Google while a customer is choosing a time.
5. Keep it fresh: Google `events.watch` and Microsoft subscriptions call the webhook; the webhook checks the channel token, writes an outbox row, and the worker pulls changes with the saved sync token. A full resync runs when the token is rejected. CalDAV calendars are polled every 5 minutes.
6. **Channels expire.** The hourly renewal job re-creates any channel within 24 hours of expiry. A connection whose token is revoked is marked "Needs reconnecting", the staff member is told, and their availability falls back to Kalendr's own data.

*Session break.*

*Session 2: write appointments out.*

7. When an appointment is booked, moved or cancelled, the worker creates, updates or deletes an event in the calendar the staff member chose, and records the link and etag. Event text follows a per-business privacy setting: full details, first name and service, or just "Busy".
8. Events Kalendr created are skipped when reading busy time, so an appointment never blocks itself.

*Session break.*

*Session 3: changes made outside Kalendr.*

9. When a linked event is moved or deleted in the outside calendar, **never change the appointment automatically.** Raise it in "Needs a person" with both times and two buttons: "Move the appointment to match" (which runs the normal reschedule with customer notice) or "Put the calendar event back".
10. Add a subscribe-only calendar feed per staff member (a private `.ics` address) for people who only want to see their Kalendr day in another calendar without connecting an account.
11. Limits by plan (feature 14).

**Done when.** With test accounts: an event added in Google Calendar removes that slot from the public booking page within a minute. A Kalendr booking appears in Outlook and moves when rescheduled. Deleting the event in Google raises a "Needs a person" item and does not cancel the appointment. A revoked token shows "Needs reconnecting" and booking still works. A channel about to expire is renewed by the job.

**Needs.** Features 1 and 10. Google app verification for calendar scopes (start early) and a Microsoft app registration.

---

### 17. Repeating appointments

**Size:** M

**Why it matters.** Physiotherapy courses, weekly tuition, monthly hair colour and dialysis are all the same booking many times. Staff currently enter each one by hand. This has been an open item in the project's own plan since the start.

**Use.** `rrule` 2.8.1.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `appointment_series` (customer, service, staff member, location, rule text, starts on, ends on or count, status); `appointments.series_id`, `appointments.series_index` |
| Server | new `src/server/series.ts`; extend `src/server/appointment-repository.ts` |
| Routes | new `src/app/api/staff/series/route.ts`, `[id]/route.ts` |
| Screens | `src/features/clinic/new-appointment-task.tsx` (a "Repeat" control), `appointment-task.tsx` (edit scope dialog) |

**How.**

1. The "Repeat" control offers: does not repeat, daily, weekly on chosen days, every N weeks, monthly on the same date or the same weekday, with an end date or a count. Cap at 52 occurrences or 12 months.
2. Expand the rule in the **location's timezone**, so a 10 am weekly visit stays at 10 am across a clock change.
3. Before saving, check every occurrence and show a list: free, or clashing (with what). For each clash the staff member chooses skip, or pick another time that day from the offered slots.
4. Save the series and all its appointments in **one transaction**. If any chosen occurrence fails a database constraint at commit, nothing is saved and the list is shown again.
5. Editing or cancelling an occurrence asks: **this one**, **this and following**, or **all**. "This and following" ends the old series and starts a new one. Completed and checked-in visits are never changed.
6. Messages: one confirmation for the whole series with the dates listed, then the normal reminders per visit (feature 5).
7. Show a small repeat mark on series appointments in the schedule, and a series view listing all visits with their status.
8. Customers can cancel or move a single visit from the portal. Changing the whole series is for staff.
9. With payments (23), a series can be paid per visit or up front; with packages (25), each visit can draw down a package.

**Done when.** "Every Tuesday at 10 am for 8 weeks" creates 8 appointments in one action, with one clash offered an alternative. Moving "this and following" from visit 4 to Wednesday leaves visits 1–3 alone. A series crossing a clock change keeps its local time. Cancelling "all" leaves completed visits untouched.

**Needs.** Feature 5 for the combined confirmation.

---

### 18. Group sessions and classes

**Size:** L

**Why it matters.** Yoga studios, coaching centres, workshops and group therapy sell seats, not one-to-one slots. Without capacity, Kalendr cannot serve fitness, education or events businesses at all.

**Use.** No new library.

**Where.**

| Change | Path |
| --- | --- |
| Schema | `services.kind` (`appointment` or `class`), `services.capacity`; `class_sessions` (service, staff member, location, room, starts, ends, capacity, status, series id); `class_enrolments` (session, customer, status: booked, waitlisted, attended, cancelled or no-show; **unique on session + customer**) |
| Server | new `src/server/classes.ts` |
| Routes | new `src/app/api/staff/classes/*`, `src/app/api/public/classes/*` |
| Screens | new `src/features/clinic/classes-workspace.tsx`; a session card in the schedule; `src/features/booking/*` gains a class timetable |

**How.**

1. A class is a service with a capacity. A session is one dated occurrence. Sessions are created one at a time or as a repeating timetable (reuse the rule code from feature 17).
2. A session blocks its staff member and room in the same exclusion constraints as an appointment, so a teacher cannot be double-booked between a class and a one-to-one.
3. **Booking a seat must be safe when the last seat is contested.** In one transaction: lock the session row (`SELECT … FOR UPDATE`), count active enrolments, insert if below capacity, otherwise offer the waitlist. Add a database check so a count above capacity cannot be committed.
4. The public page shows a timetable: date, time, teacher, seats left ("3 left", or "Full: join the waitlist").
5. One customer can book several seats for named guests when the business allows it; each guest is an enrolment.
6. Session waitlist: when someone cancels, the first person waiting is offered the seat with a timed hold (reuse feature 21).
7. Staff see a roster per session with one-tap attendance (present, absent), walk-in add, and a message-everyone action through the workflow engine.
8. Cancelling a session tells everyone and applies refunds or returns credits (features 23 and 25).
9. Minimum numbers: optionally cancel automatically and notify if fewer than N are enrolled a set time before the start.
10. Reports (26) gain fill rate per class.

**Done when.** Twenty people try to book the last 2 seats at the same moment: exactly 2 succeed and 18 are offered the waitlist. A cancellation offers the seat to the first person waiting. A teacher cannot be given a one-to-one that overlaps their class. The roster marks attendance.

**Needs.** Features 5 and 21. Feature 17 for repeating timetables.

---

### 19. Video visits

**Size:** M

**Why it matters.** Follow-up consultations, therapy, tutoring and advisory calls do not need a room. Offering them widens every business's catchment and fills quiet hours, and customers expect the join link in the reminder.

**Use.** Daily (REST API on the server, `@daily-co/daily-js` 0.95.0 in the browser), behind an adapter.

**Where.**

| Change | Path |
| --- | --- |
| Schema | `services.delivery_modes` (in person, video, phone); `appointments.delivery_mode`; `video_rooms` (appointment, provider room name, expires at) |
| Adapter | new `src/server/video/provider.ts`, `daily.ts`, `fake.ts` |
| Routes | new `src/app/api/public/visit/[token]/route.ts`, `src/app/api/staff/appointments/[id]/video/route.ts` |
| Pages | new `src/app/visit/[token]/page.tsx`; a "Join" button in `appointment-task.tsx` |

**How.**

1. A service can allow one or several delivery modes. The customer chooses at booking when more than one is on. Video and phone visits need no room, so they skip the room constraint.
2. Create the room lazily: the worker makes it 15 minutes before the start, set to expire 30 minutes after the end. Nothing is created for visits that get cancelled.
3. Joining needs a **short-lived meeting token made per person**, never a reusable link. The customer's `/visit/[token]` page checks the manage token, then asks the server for a meeting token valid only around the appointment time. Staff join from the appointment with their own token carrying host rights.
4. Before joining, show a check screen: camera, microphone, speaker test, and the other person's status ("Dr Rao has not joined yet").
5. A waiting room: customers wait until staff admit them.
6. Joining marks the appointment checked in. Leaving does not complete it; staff do that.
7. **No recording by default.** Recording is off unless a business turns it on, and then both sides see a clear notice and must agree. Do not build recording in the first version.
8. Reminders for video visits carry the join link and a "test your camera" link. Add `{join_link}` to the template variables in feature 5.
9. Add the video provider's domains to the CSP, and `camera` and `microphone` to the permissions policy for the visit page only.
10. Fallback: if the call fails, show the business's phone number and a "Switch to phone call" note staff can send in one tap.
11. Keep the adapter small (create room, create token, end room) so another provider can replace Daily later.

**Done when.** A customer books a video follow-up, gets a reminder with a join link, passes the device check, waits, and is admitted by the staff member; both see and hear each other on a phone and a laptop. The link does not work an hour after the visit. A cancelled visit never creates a room.

**Needs.** Features 1 and 5. A Daily account.

---

### 20. Team routing

**Size:** L

**Why it matters.** Many customers do not care who they see; they want the earliest time. Showing only per-person availability hides most free slots. Fair distribution across staff also matters to owners, and holiday cover is a weekly headache.

**Use.** No new library.

**Where.**

| Change | Path |
| --- | --- |
| Schema | `practitioner_services.priority`, `practitioner_services.weight`; `services.assignment` (customer chooses, any available, or round robin); `time_off` (staff member, from, to, cover staff member, reason) |
| Server | new `src/server/routing.ts`; the availability query in `src/server/appointment-repository.ts` |
| Public API | `src/app/api/public/availability/route.ts` accepts "anyone" |
| Screens | `src/features/booking/*` ("Anyone available" first in the list), `team-workspace.tsx`, `availability-settings.tsx` |

**How.**

1. Pooled availability: a slot is offered when **at least one** eligible staff member is free. Compute it as the union of each person's free time for that service.
2. The booking screen lists "Anyone available: earliest time" first, then each person with their next free time.
3. Choose the person **at commit time, inside the booking transaction**, not when the slot was shown, because the person who was free may have been taken. The order:
   1. Only people free at that time, who offer the service at that location.
   2. Highest `priority` first.
   3. Among equals, the person furthest below their fair share, where fair share is their `weight` against confirmed bookings in the last 30 days.
   4. Then the person booked least recently.
   A new team member is treated as having the team's average count so they are not flooded.
4. If the chosen person's insert hits the overlap constraint, try the next. Fail only when nobody is free.
5. Returning customers: optionally prefer the person they saw last time when that person is free.
6. Time off: a staff member (or manager) records leave. Their slots close. With a cover person set, new "anyone" bookings route to the cover, and existing bookings appear in a list to **reassign in bulk**: one click moves each to the cover when they are free at that time, and the rest go to "Needs a person".
7. Reassigning keeps the same appointment, time and manage link; only the staff member changes, with a version check and a message to the customer naming the new person.
8. Requests for a specific person can carry a different price or deposit (with feature 23).
9. Show each person's share of bookings for the month on the Team screen so owners can see it is fair.
10. Unit-test the selection function hard: it is pure and easy to get subtly wrong.

**Done when.** With three stylists, the public page shows the union of their free times under "Anyone available". Thirty "anyone" bookings spread in line with weights 2:1:1. Two customers taking the same "anyone" slot at once get two different stylists. A stylist's week off moves their bookings to the cover person in one action, and customers are told.

**Needs.** Feature 5 for the reassignment message.

---

### 21. Smart waitlist

**Size:** M

**Why it matters.** A cancellation is lost income unless someone takes the slot. The waitlist exists today but staff must phone people one by one. Offering the slot automatically, to the right person, with a hold, fills gaps with no staff effort.

**Use.** No new library.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `slot_offers` (waitlist entry, staff member, starts, ends, token hash, expires at, status: sent, accepted, declined, expired or withdrawn) |
| Server | new `src/server/waitlist-offers.ts`; existing waitlist code in `src/server/staff-operations.ts` |
| Routes | new `src/app/api/public/offers/[token]/route.ts`; page `src/app/offer/[token]/page.tsx` |
| Worker | handlers `waitlist-match`, `offer-expire` |
| Screens | `src/features/clinic/follow-ups-workspace.tsx`; a "Join the waitlist" step in `src/features/booking/*` |

**How.**

1. Customers can join the waitlist themselves from the booking page when no time suits: service, preferred people, date range, and time of day. This uses the existing `waitlist_entries` columns.
2. When a slot opens (cancel, reschedule away, a block removed, new hours), the worker finds matching active entries: same service and location, date in range, time of day fits, staff member acceptable.
3. Order them by the business's rule: longest waiting first (default), or soonest existing appointment first (people who want to come earlier).
4. Offer to **one person at a time**. Create a `slot_offers` row and a held `resource_reservations` row so the slot leaves public availability. Send a message with an accept link: "A 4 pm slot on Tuesday has opened. Take it within 15 minutes."
5. Accepting is one tap after the link opens, with no sign-in: the token is the proof. It books the appointment through the normal transaction, converts the hold, marks the entry `fulfilled`, and, if the customer already had a later appointment for the same service, offers to cancel that one (which may itself free a slot).
6. No answer in 15 minutes, or a decline: mark the offer expired, release it, and offer the next person. After three people, or when the slot is under two hours away, release it to public booking.
7. Hold time shortens as the slot gets nearer: 15 minutes normally, 5 minutes inside 3 hours.
8. Respect quiet hours: do not message at night; start the cascade at opening time.
9. Staff see each open slot's offer trail (who was asked, who answered) and can offer by hand or switch the automation off per service.
10. The existing `waitlist_status` values already cover this: `active`, `offered`, `fulfilled`, `expired`, `declined`.

**Done when.** A cancelled 4 pm slot is offered to the first matching person; they ignore it; after 15 minutes the second person gets it and accepts in one tap; the appointment appears on the schedule and the slot never showed on the public page in between. Two people tapping an old and a current offer cannot both book. Nothing is sent at 2 am.

**Needs.** Features 1 and 5 (3 for WhatsApp offers).

---

### 22. Walk-in queue and token screen

**Size:** L

**Why it matters.** Most clinics and many salons in India run mostly on walk-ins with paper tokens. A product that handles only pre-booked appointments covers a fraction of their day. A live queue with a waiting-room screen is a visible, daily-use feature that sells itself at the front desk.

**Use.** `uqr` (already installed) for the check-in code. Live updates from feature 32.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `queue_tickets` (location, date, token number, customer, appointment or none, staff member or any, status: waiting, called, in room, done, skipped or left; priority; joined at; called at), `queue_counters` (location, date, last number), `queue_displays` (location, token hash) |
| Server | new `src/server/queue.ts` |
| Routes | new `src/app/api/staff/queue/*`, `src/app/api/public/queue/[token]/route.ts` |
| Pages | new `src/app/queue/[locationToken]/page.tsx` (the wall screen), `src/app/q/[ticketToken]/page.tsx` (the customer's phone view); extend `src/app/check-in/[token]` |
| Screen | new `src/features/clinic/queue-workspace.tsx`, linked from the dashboard |

**How.**

1. Token numbers restart each day per location. Issue them by locking the `queue_counters` row, so two front desks never give the same number.
2. Ways into the queue: staff add a walk-in (name and phone, about 10 seconds); a booked customer checks in (existing check-in page) and gets a token; or a customer scans a QR code at the door and adds themselves.
3. Order: by default, booked customers are called at their time and walk-ins fill the gaps. The business can choose strict arrival order instead. Staff can mark a ticket urgent, which moves it up and records who did it and why.
4. Staff controls: **Call next**, Call again, Start, Done, Skip, Left. "Call next" takes the right ticket for that staff member in one transaction so two rooms never call the same person.
5. Estimated wait: people ahead for that staff member times their recent average visit length. Show it as a range ("about 20–30 minutes") and update it live.
6. The wall screen is opened on a TV with a secret link. It shows **only token numbers and room names**, never customer names, in large type with a chime on each call. It needs no sign-in and shows nothing else about the business's data.
7. The customer's phone page shows their token, how many are ahead and the estimate, and offers "Tell me when I'm next".
8. Send "You are next, please come in" by WhatsApp when two people are ahead (feature 3).
9. A walk-in becomes a normal appointment record when called, with booking source `walk_in`, so reports and the customer's history stay complete.
10. At closing time, clear remaining tickets with a reason, and report the day: number seen, average wait, longest wait.

**Done when.** Two front-desk staff add walk-ins at once and get consecutive tokens. The wall screen updates within two seconds of "Call next" and shows no names. A customer who scanned the QR sees their position fall as others are called and gets a WhatsApp when nearly up. Two rooms pressing "Call next" together get different tickets.

**Needs.** Feature 32 for live updates (poll every 5 seconds until then). Feature 3 for the alert.
