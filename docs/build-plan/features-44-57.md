# Features 44–57: Trust, reach, and the platform around Kalendr

Read `STANDARDS.md` first. Each feature has six parts: **Why it matters**, **Use**, **Where**, **How**, **Done when**, **Needs**.

These features came from the Cal.com comparison in [CALCOM_GAP_ANALYSIS.md](CALCOM_GAP_ANALYSIS.md). They describe the behaviour in our own words; do not copy Cal.com source. Numbers 47 and 49 are unused.

Migrations here start at `0034`, after features 36–43 (`0026`–`0033`). When several are built at once, renumber at merge time as the README's build rules say.

---

## I. Trust and reach (stage 9)

### 44. Spam protection

**Size:** M

**Why it matters.** Feature 9 stops floods: too many codes, too many requests, bots. It does not stop one person who keeps booking fake visits with a throwaway email, or a known troublemaker who books under a new name each week. Staff need a way to say "this booking is spam", have it cleaned up, and stop the same person booking again, without that person learning they were blocked.

**Use.** No new library.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0034_spam_protection`) | new `blocklist_entries` (tenant, kind: `email`, `phone`, `email_domain`; value hash; display hint such as `r***@gmail.com`; reason code; added by; created); new `booking_reports` (tenant, appointment, reported by, reason code, status: `open`, `ignored`, `blocked`; decided by, decided at); `appointments.spam_state` (`none`, `reported`, `silently_refused`) |
| Server | new `src/server/spam.ts` (checks and decisions); booking commit in `src/server/appointment-repository.ts` |
| Routes | new `src/app/api/staff/blocklist/route.ts`, `src/app/api/staff/booking-reports/route.ts`, `[id]/route.ts`; `src/app/api/staff/appointments/[id]/route.ts` gains `report_spam` |
| Screens | "Report as spam" in the ⋯ menu of `appointment-task.tsx` and in feature 43's bulk actions; a "Spam" section in `settings-workspace.tsx` with the review queue and the blocklist |

**How.**

1. **Blocklist values are stored hashed** (HMAC with a tenant-scoped key, the same way the app already hashes tokens), with a short masked hint for staff to recognise them. Emails are lowercased and trimmed; Gmail dots and `+tags` are removed before hashing so `r.a.j+x@gmail.com` matches `raj@gmail.com`. Phones are normalised to E.164 first.
2. **Silent refusal.** When a booking's email, phone or email domain is on the blocklist, the commit does not create a real appointment. It returns the same success response shape and confirmation screen a real booking gets, sends nothing, holds no slot, and writes one `audit_events` row with outcome `refused` and no contact details. The time taken must look the same as a real booking (do the same work, then discard), so the response doesn't reveal the block.
3. **Report a booking.** Staff pick a reason (fake details, abusive, duplicate, other). The booking and any future repeats of it (feature 17) are cancelled by the system without telling the customer, and a report opens in the review queue.
4. **Review queue.** An admin sees each open report with the masked contact and booking history, and chooses **Ignore** (closes it) or **Block** (adds the email, phone or whole domain to the blocklist). Blocking a domain that is a big free-mail provider (the list from feature 41) is refused with an explanation.
5. Owners and admins manage the blocklist directly too: add, remove, see who added an entry and why. Removing an entry never restores cancelled bookings.
6. Never log the raw email or phone at any step; logs carry only the hint.
7. Tests: the silent response is byte-for-byte the same shape as a real one; the Gmail normalisation; repeats get cancelled; a blocked domain blocks every address in it.

**Done when.** A staff member reports a fake booking; it and its repeats are cancelled and appear in the review queue. The admin blocks the email. A new booking from that email (with dots or a `+tag` added) shows the normal confirmation, but no appointment, message or held slot exists, and the audit log has one refused entry with no contact details.

**Needs.** Feature 9 for rate limits (separate, complementary). Feature 17 for repeats (works without it). Feature 43 for bulk report (the single action works before it).

---

### 45. Special links

**Size:** S

**Why it matters.** A business wants to send one VIP a link that books a hidden slot once and then stops working; a clinic offers a free first visit through a link valid only this month; a couple's therapist needs both therapists booked together from one link. Today every link is permanent and public.

**Use.** No new library.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0035_special_links`) | new `special_links` (tenant, service, token hash, label, kind: `single_use`, `limited`, `expiring`; max uses; used count; expires at; revoked at; created by); new `combined_links` (tenant, slug, service, practitioner ids array of 2–4); `appointments.special_link_id` |
| Server | new `src/server/special-links.ts`; booking commit checks and counts the use |
| Routes | new `src/app/api/staff/special-links/route.ts`, `[id]/route.ts` (revoke); public pages `src/app/l/[token]/page.tsx` and `src/app/b/[slug]/with/[combo]/page.tsx` |
| Screens | "Special links" item in each service's ⋯ menu (from feature 36's editor) opening a sheet that lists, creates and revokes links |

**How.**

1. A special link is a 256-bit token stored hashed; the full link is shown once at creation with "Copy". It books one service, including hidden services (feature 36).
2. Kinds: **single use** (works once), **limited** (N uses), **expiring** (until a date and time), and limited plus expiring together.
3. **Counting is in the booking transaction:** `update special_links set used_count = used_count + 1 where id = … and used_count < max_uses and (expires_at is null or expires_at > now()) and revoked_at is null returning id`. No row returned means the link is used up, and the booking is refused. Two people on a single-use link at once: exactly one books.
4. A spent, expired or revoked link shows a plain page: "This link has already been used. Contact the business to book." with the business's phone.
5. **Combined links** book two to four people at once for the same time: only slots where **all** of them are free are offered, and the commit creates one appointment per person in one transaction (all or nothing), sharing a `group_ref` so they move and cancel together.
6. The list shows each link's label, uses, expiry and status, and the bookings made through it.

**Done when.** A single-use link books once; opening it again shows the "already used" page; two simultaneous attempts give one booking. A link expiring at midnight refuses a booking at 00:01. A combined link for two therapists offers only times both are free and creates two linked appointments.

**Needs.** Feature 36 for hidden services and the service editor.

---

### 48. Service templates

**Size:** M

**Why it matters.** A chain with 12 branches and 40 staff wants "Standard haircut" to be the same everywhere: same length, price and questions. Today each copy is edited by hand and they drift apart. Owners want to define it once, push it out, and lock the fields branches must not change, while letting each branch set what is genuinely local.

**Use.** No new library.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0036_service_templates`) | new `service_templates` (tenant, name, settings jsonb validated by the feature 36 service schema, locked field names array, version); `services.template_id`, `services.template_version` |
| Server | new `src/server/service-templates.ts` |
| Routes | new `src/app/api/staff/service-templates/route.ts`, `[id]/route.ts`, `[id]/assign/route.ts` |
| Screens | a "Templates" tab in services settings; locked fields in `service-editor.tsx` show a lock icon and "Set by the template" |

**How.**

1. An owner or admin creates a template from scratch or from an existing service ("Make a template"). It holds every service setting from feature 36, including lengths, prices, location options, forms and limits.
2. **Assign** to branches and people: each assignment creates (or links) a real service row with `template_id`. Bookings always point at real services, never at templates.
3. **Locked fields** can't be changed on the copies; the server rejects a PATCH that touches one, not just the screen. Unlocked fields are local to each copy.
4. **Publishing a change** bumps the template version and updates every copy's locked fields in one transaction, then records the new version on each. Unlocked fields are left alone. Existing bookings keep their booked length and price.
5. Show a summary before publishing: "Changes price on 12 services. 3 services have local changes to unlocked fields, which stay."
6. Unlinking a copy keeps its current settings and makes it a normal service.
7. Templates need the `services.manage` permission (or the custom role area from feature 53).

**Done when.** An owner creates "Standard haircut" with a locked price, assigns it to 12 branches, and a branch manager can change the description but gets an error trying to change the price. Raising the template price updates all 12 in one step; bookings already made keep the old price.

**Needs.** Feature 36.

---

### 50. Calendar entry wording

**Size:** S

**Why it matters.** Every confirmation carries a calendar invite, and calendar sync (feature 16) writes events into staff calendars. Today the title is fixed. Businesses want "Haircut with Priya (Kalendr)" for customers and "Priya Sharma: Haircut, chair 2" for staff, and some must keep notes or answers out of calendar entries because calendars are shared in the office.

**Use.** No new library. The template is simple `{placeholder}` replacement, not a template engine.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0037_calendar_wording`) | `services.customer_event_title`, `services.staff_event_title`, `services.event_description`; `services.hide_notes_in_calendar`, `services.hide_details_in_calendar`; `tenants.reply_to_email` |
| Server | new `src/lib/event-wording.ts` (pure); `src/server/icalendar.ts`; feature 16's calendar writer; feature 2's email sender for reply-to |
| Screens | a "Calendar entry" section in `service-editor.tsx` with a live preview |

**How.**

1. Placeholders: `{service}`, `{customer}`, `{customer_first_name}`, `{person}`, `{business}`, `{branch}`, `{location}`, `{length}`, and any booking question by its key. Unknown placeholders are shown as typed and flagged in the editor.
2. `event-wording.ts` fills the template, strips line breaks from titles, caps titles at 200 characters, and escapes for iCalendar (commas, semicolons, backslashes, newlines) in one place. Unit-test it with names containing commas and emoji.
3. **Customer and staff wording are separate.** The customer's invite never shows staff-only fields (internal notes, room names if hidden).
4. **Hide notes** keeps the customer's notes out of every calendar entry. **Hide details** writes only "Busy: {business}" into staff calendars (for shared office calendars) while Kalendr still shows everything.
5. **Reply-to:** confirmation emails use the business's reply-to address so a customer's reply reaches the business, not a no-reply mailbox. Verify the address with a one-time code before using it.
6. The preview shows the customer's and the staff member's entry for a sample booking.

**Done when.** A business sets "{service} with {person}" and the next confirmation's invite has that title. With "hide details" on, a staff member's Google Calendar shows "Busy: Glow Salon" and nothing else. A customer replying to a confirmation email reaches the business's verified address.

**Needs.** Feature 2 (emails and reply-to), feature 16 (staff calendars; invites work before it).

---

### 51. Ratings and feedback

**Size:** M

**Why it matters.** Reviews already exist: customers can rate a finished visit for 60 days and the business can hide reviews from its page. But nobody is asked at the right moment, so few reviews come in; there is no private channel for "this went badly", and owners can't see satisfaction by person or service over time.

**Use.** No new library.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0038_feedback`) | `reviews.visibility` (`public`, `private`); `reviews.source` (`manage_link`, `rating_link`, `staff`); new `rating_requests` (tenant, appointment, token hash, sent at, opened at, answered at, expires at) |
| Server | `src/server/reviews.ts`, new `src/server/rating-requests.ts` |
| Routes | new public page `src/app/r/[token]/page.tsx` and `src/app/api/public/ratings/[token]/route.ts` |
| Worker | a feature 5 workflow step "Ask for a rating" that inserts a `rating_requests` row and queues the message |
| Screens | the rating on the appointment (`appointment-task.tsx`) and on the customer; the reviews screen gains filters for private feedback; feature 26 reports gain a satisfaction card |

**How.**

1. **The ask.** A workflow step (feature 5) sends a short message some hours after the visit is marked complete, with a one-tap link. Default: 2 hours after, once per visit, never more than once a month per customer, and never after a no-show or cancellation.
2. **The rating page** needs no sign-in (the token is the proof, 256-bit, hashed, valid for the existing 60-day window). Five stars in one tap, then an optional comment, and a choice: "Show on the business page" or "Only for the business". It reuses the existing review validation in `src/lib/reviews.ts`.
3. **Low scores** (1–2 stars) notify the owner or branch manager (feature 56) so they can call the customer. They are private by default.
4. **On the booking:** the score and comment show on the appointment and the customer profile.
5. **Reports:** average rating and satisfaction (share of 4–5 stars) by person, service and branch over time, plus response rate (feature 26).
6. The rating page asks once; reopening the link after answering shows "Thanks, you rated 5 stars" and lets them edit the comment for 7 days.

**Done when.** A completed visit triggers a rating message 2 hours later; one tap records 4 stars; the score shows on the appointment. A private 1-star review alerts the manager and never appears on the business page. The reports screen shows each person's average and satisfaction for the month.

**Needs.** Feature 5 for the timed ask, features 2–4 to send it, feature 26 for the report card, feature 56 for low-score alerts.

---

### 52. Embeds and conversion

**Size:** M

**Why it matters.** Many businesses book through their own website. There is an embed demo today with one "booking completed" message to the host page. To use it seriously they need a builder that writes the code for them, more events (so their analytics see each step), a way to send the customer to their own thank-you page, their own tracking pixels, and short links for printed cards and Instagram bios.

**Use.** No new library for the embed. `qrcode` (already used for the confirmation QR; check `package.json`) for link QR codes.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0039_embeds`) | `services.after_booking` (`kalendr_page`, `redirect`), `services.redirect_url`, `services.pass_details_on_redirect`, `services.success_message`, `services.hide_success_details`; new `tracking_settings` (tenant, Google Analytics id, Tag Manager id, Meta pixel id, Plausible domain); new `short_links` (tenant, code, target path with prefill, created by, clicks) |
| Embed | `src/app/embed-demo/booking-embed-bridge.tsx` becomes `src/lib/embed/bridge.ts`; a small script served at `/embed.js` (inline, popup and floating button modes) |
| Routes | new `src/app/s/[code]/route.ts` (short link redirect); `src/app/api/staff/short-links/route.ts`, `tracking/route.ts` |
| Screens | new "Share and embed" sheet from the business page settings and each service: link, short link, QR, embed builder with a live preview |

**How.**

1. **Embed builder.** Choose inline, popup or floating button; pick a service or the whole page; set the theme (light, dark, auto), brand colour and layout (feature 39). The preview runs the real embed. Copy one snippet.
2. **Events.** The embed posts these to the host page: `opened`, `service_selected`, `slot_selected`, `booked`, `rescheduled`, `cancelled`, `failed`. Messages carry ids and times only, never names, email or phone. The bridge only posts to the parent origin it was opened from, and the host listens with a documented helper.
3. **Prefill and UTM** pass from the host page URL into the embed (feature 40's prefill keys), so campaign tracking survives.
4. **After booking:** show Kalendr's confirmation (with a custom message, optionally without details) or redirect to the business's URL. With "pass details" on, add only the booking id, service, start time and a signed short-lived summary token; never put the customer's name, email or phone in the URL.
5. **Pixels.** The business enters ids, not script code. Kalendr injects the official snippet for each provider on the public booking pages only, never on staff, portal or manage pages, and only after the visitor accepts analytics cookies (a consent banner, decline by default). Update the Content Security Policy for exactly those hosts.
6. **Short links** `/s/abc12` redirect to a booking page with optional prefill. Codes are 7 random characters; count clicks without storing IP addresses.
7. **Email booking link.** The share sheet offers a "Times for an email" snippet: plain HTML of the next 6 open slots, each linking to the booking page with that time preselected. It is a snapshot; the booking page re-checks the slot.

**Done when.** A business builds a popup embed in the sheet, pastes it into a test page, and the host page receives `slot_selected` and `booked` events with no personal details. A service set to redirect sends the customer to the business's thank-you page with the booking id. With a Meta pixel id saved, the pixel loads only after consent and only on the booking page. A printed short link opens the right service with the campaign tag filled.

**Needs.** Feature 34 for the documented host-page API. Features 39 and 40 for layouts and prefill.

---

### 56. Staff notifications

**Size:** M

**Why it matters.** Staff hear about bookings only by looking at the screen. A practitioner wants a push alert when someone books with them tomorrow; a manager wants one email at 7 a.m. listing the day; a receptionist wants nothing outside working hours. One fixed rule for everyone means either noise or missed changes.

**Use.** No new library beyond feature 32's web push.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0040_staff_notifications`) | new `staff_notification_prefs` (membership, event type, channel: `email`, `in_app`, `push`; on or off); `memberships.quiet_hours_start`, `quiet_hours_end`, `digest_time`; new `staff_inbox_items` (membership, event type, appointment, read at, created) |
| Server | new `src/server/staff-notify.ts` (fans an event out to each staff member's chosen channels via the outbox) |
| Worker | handlers `staff-notify`, `staff-digest` (runs every 15 minutes, sends digests whose local time has come) |
| Routes | new `src/app/api/staff/me/notifications/route.ts` (preferences), `src/app/api/staff/inbox/route.ts` |
| Screens | a bell with an unread count in the shell; a "Notifications" page in the profile menu with a table of events × channels |

**How.**

1. **Events:** new booking, request needing approval (feature 41), cancelled, rescheduled, customer message (feature 3), low rating (feature 51), form received, waitlist filled (feature 21), out-of-office forward (feature 37).
2. Each person chooses channels per event in a simple grid of switches. Sensible defaults by role: practitioners get their own bookings by push and in-app; receptionists get everything in-app; owners get the digest by email.
3. **Who is told:** the person the booking is with, plus roles that cover the branch. Never notify people who can't see the appointment under their permissions.
4. **Quiet hours** hold push and email until they end; in-app items still appear.
5. **Daily digest** at each person's chosen local time: their day's bookings, requests waiting, and yesterday's cancellations. Skipped when there is nothing to say.
6. Push and email bodies carry the time, service and customer first name only; never phone, email or notes.
7. All sending goes through the outbox and the worker; the request that changed the booking only writes outbox rows.

**Done when.** A practitioner who chose push gets an alert within a minute when a customer books with them, and nothing during quiet hours until they end. An owner gets a 7 a.m. email listing the day. A receptionist's bell shows unread items and marks them read.

**Needs.** Feature 2 (email), feature 32 (push and the bell's live count; works with refresh before it).

---

## J. The wider platform (stage 10)

### 46. Routing forms

**Size:** XL

**Why it matters.** A multi-specialty clinic or a large salon has dozens of services and people. Customers don't know whether they need "consultation" or "follow-up", or which doctor speaks Tamil. A few questions first, then the right service and the right person, removes wrong bookings and the calls that fix them. Owners also want to see where people drop off.

**Use.** No new library. The form reuses feature 40's question types and condition function.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0041_routing_forms`) | new `routing_forms` (tenant, name, slug, questions jsonb, routes jsonb, fallback route jsonb, status draft or live, version); new `routing_responses` (tenant, form, version, answers encrypted, matched route id, outcome: `booked`, `abandoned`, `external`, `message`; appointment id; trace jsonb; created); new `wrong_assignment_reports` (tenant, appointment, reported by, correct practitioner, note encrypted, status) |
| Attributes | `practitioner_attributes` and `attribute_definitions` from feature 53 (build that part of 53 first, or create the two tables here with 53's columns) |
| Server | new `src/server/routing-forms/` (`evaluate.ts` pure, `trace.ts`, `report.ts`); feature 20's chooser takes an extra candidate filter and weights |
| Routes | public page `src/app/f/[slug]/page.tsx`; `src/app/api/public/routing/[slug]/route.ts` (POST answers, returns where to go: also the headless entry point); staff routes under `src/app/api/staff/routing-forms/*` |
| Screens | new `src/features/clinic/routing-forms-workspace.tsx` (builder, preview, report) |

**How.**

1. **A form** is a short list of questions (feature 40 types). **Routes** are checked in order: each has conditions on the answers and a destination: a service (with an optional set of people), an outside URL, or a custom message. A **fallback** applies when nothing matches; a form can't go live without one.
2. **Attribute routing.** A route can say "people whose Language includes the answer to Q2" or "Speciality equals Dermatology". This narrows the candidate list given to feature 20's chooser. Attribute **weights** (say, senior staff 2) feed into its fair-share step.
3. **Answers flow on**: matching booking questions are prefilled from the routing answers (by shared key), so the customer isn't asked twice.
4. **Builder checks.** Warn when a route can never be reached because an earlier route catches every case it would, and when a destination service is hidden or inactive. **Preview** lets staff type answers and see which route matches and which people would be offered, without saving anything.
5. **Headless.** A business's own website form can POST answers to the routing endpoint and get back the booking URL (with prefill) or message. Validate with zod; rate-limit per IP (feature 9).
6. **Trace.** Each response records which route matched, which conditions passed, the candidate people and why each was or wasn't chosen. Staff see it on the booking ("Routed by: Language = Tamil, Dr Iyer had the fewest bookings this month").
7. **Report.** Responses per route, booked versus not, the drop-off funnel (opened → answered → slot shown → booked), and a CSV export that leaves out encrypted free text.
8. **"Answered but didn't book"** becomes a trigger for feature 28's campaigns, only for customers who gave marketing consent.
9. **Wrong assignment.** Staff report "this should have gone to Dr Shah"; admins review and use the list to fix routes.
10. Changing a live form creates a new version; responses keep the version they were answered with.

**Done when.** A clinic form asks "First visit?" and "Language?" and sends a first-time Tamil speaker to a consultation with a Tamil-speaking doctor, with the answers prefilled. A form with an unreachable route shows a warning in the builder. The preview never writes data. The report shows how many people answered but didn't book last week. Each routed booking shows its trace.

**Needs.** Feature 20 (chooser), feature 40 (question types and conditions), feature 53's staff attributes. Feature 28 for the follow-up trigger.

---

### 53. Enterprise and teams

**Size:** XL

**Why it matters.** Hospital groups and large chains buy differently: they sign in with their company accounts, add and remove staff from their HR system, need departments with their own pages, need roles shaped to their organisation, and must be able to show auditors who did what. Without these, Kalendr stops at mid-sized businesses.

**Use.** better-auth's SSO plugin for SAML and OIDC and its SCIM plugin, if the installed version has them (read its docs in `node_modules` first); otherwise `@node-saml/node-saml` for SAML and `openid-client` for OIDC. No other new library.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0042_enterprise`) | new `teams` (tenant, parent team, name, slug, is private); `team_members` (team, membership); new `sso_connections` (tenant, kind SAML or OIDC, metadata or issuer, client secret encrypted, domain, status); new `scim_tokens` (tenant, token hash, created, last used); new `verified_domains` (tenant, domain, verification token hash, verified at, auto-join role); new `custom_roles` (tenant, name, permissions array); `memberships.custom_role_id`; new `attribute_definitions` (tenant, name, kind: text, single choice, multiple choice, number) and `practitioner_attributes` (practitioner, attribute, value); `tenants.defaults` (timezone, clock, week start, message templates) |
| Server | `src/lib/permissions.ts` and `src/server/staff-context.ts` (custom roles), new `src/server/sso.ts`, `src/server/scim.ts`, `src/server/domains-verify.ts` |
| Routes | `src/app/api/auth/*` for SSO; new `src/app/api/scim/v2/Users/route.ts`, `Groups/route.ts`; staff routes under `src/app/api/staff/teams/*`, `roles/*`, `sso/*`, `domains/*`, `attributes/*`; `src/app/api/staff/activity/route.ts` gains filters |
| Screens | "Organisation" section in settings: Teams, Roles, Sign-in (SSO and domains), Provisioning, Attributes, Defaults; `src/features/clinic/activity-log.tsx` becomes a filterable audit viewer; team pages at `/b/[slug]/t/[team]` |

**How.**

*Session 1: teams, roles, attributes and the audit viewer.*

1. **Teams** (departments) nest under branches or stand alone, have their own public page listing their services and people, and can be **private** (the page books but doesn't list members). Feature 38's team limits and feature 20's pools use them.
2. **Custom roles.** Start from a built-in role and tick permissions per area (appointments, customers, records, payments, settings, reports, team) with read, create, update and delete. Stored as permission keys from `src/lib/permissions.ts`, so `can()` keeps working. An owner can't remove their own last owner permission; at least one owner always remains (DB check plus server rule).
3. **Attributes**: the owner defines attributes (Language, Speciality, Gender, Seniority) and sets values per person. Used by feature 46 and as report filters.
4. **Audit viewer**: filter by person, action (sign-in, failed sign-in, role change, API key, booking change, export), date and outcome; export CSV. Metadata never contains free-text notes (existing rule).
5. **Org defaults** (timezone, clock, week start, message templates) apply to new branches and services.

*Session break.*

*Session 2: SSO, domains and SCIM.*

6. **Verified domains.** Add `clinic.com`, publish a DNS TXT record, and Kalendr checks it (in the worker, not in the request). Once verified, anyone signing in with an `@clinic.com` account can join with the chosen default role, if the owner turned auto-join on.
7. **SSO.** One SAML or OIDC connection per verified domain. Users of that domain are sent to their company sign-in; the owner can require SSO for everyone in the domain (keeping one owner break-glass account with a password and second factor from feature 6). Test against a local SAML test provider in CI, not a real Okta.
8. **SCIM.** A bearer token (hashed) lets the company's directory create, update and deactivate members. Deactivating removes sign-in at once and sends their future bookings to feature 20's reassign list; it never deletes appointments.
9. Every security change (SSO on, role edits, SCIM token created) needs a recent second-factor check (feature 6) and writes an audit event.

**Done when.** An owner creates a "Dermatology" team page and a custom "Front desk" role that can book but can't see payments; a member with that role gets 403 on payments. A test SAML provider signs a user in to the right tenant. A SCIM deactivate stops that user's sign-in within a minute and lists their bookings for reassignment. The audit viewer shows every failed sign-in last week.

**Needs.** Feature 6 (second factor, sign-in), feature 15 (platform view of SSO connections), feature 20 (reassign on deactivate).

---

### 54. AI and developer access

**Size:** M

**Why it matters.** Customers increasingly ask an AI assistant to "book me a haircut on Saturday". Businesses' developers want to drop Kalendr's booker into their own app without an iframe. Both need a safe, documented way in that uses the same rules as the booking page.

**Use.** `@modelcontextprotocol/sdk` (the official MCP TypeScript SDK; check the current version). No other new library.

**Where.**

| Change | Path |
| --- | --- |
| MCP server | new `src/app/api/mcp/route.ts` (streamable HTTP transport) and `src/server/mcp/*` (tool definitions) |
| Components | new package folder `packages/booker/` (React components: `Booker`, `AvailabilityPicker`) built on the public API from feature 34 |
| Auth | feature 34's API keys with scopes; OAuth for staff-side tools if feature 34 adds it |
| Docs | `docs/developers/mcp.md`, `docs/developers/booker.md` |

**How.**

1. **Two MCP scopes.** *Public tools*, available for any business without a key: list services, list people, find open times, start a booking. *Staff tools*, needing an API key with scopes: list today's bookings, reschedule, cancel, add a note.
2. **Booking through MCP never completes on the AI's word alone.** "Start a booking" returns a link (with the slot held for 5 minutes, feature 39) that the customer opens to confirm and enter their details, or, if the assistant collected them, a one-time code sent to the customer that they must confirm. This keeps feature 44's and feature 9's protections in front of every booking.
3. Every tool calls the same server functions as the API routes; no new booking path. Tool inputs are zod schemas; outputs leave out other customers' data entirely.
4. Rate-limit per key and per IP (feature 9). Log tool name, tenant and outcome; never the arguments' personal fields.
5. **Booker components** are a small React package that talks only to the public API: styling through CSS variables, events matching feature 52's names. Publish to npm only when the owner asks; until then build and test it in the repo.
6. Tests: an MCP client in vitest lists tools, finds times and starts a booking; a staff tool without a key is refused.

**Done when.** An MCP-capable assistant connected to Kalendr finds Saturday's open times for a service and returns a link that books it after the customer confirms. A staff key with read scope lists today's bookings and is refused when trying to cancel. A test page using the `Booker` component books through the public API.

**Needs.** Feature 34 (public API and keys), feature 39 (holds), feature 9 (limits).

---

### 55. App marketplace

**Size:** XL

**Why it matters.** Each integration built so far (calendars, payments, video, messaging) has its own settings screen and credential handling. As more arrive (Slack, CRMs, analytics, WordPress), businesses need one place to find, connect and disconnect apps, and developers need one framework so every new app gets credentials, install and uninstall right.

**Use.** Each app's official SDK only where needed (for example `@slack/web-api`); no generic integration library.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0043_apps`) | new `app_installs` (tenant, app key, status, settings jsonb validated by the app's schema, credentials encrypted, installed by, installed at); new `app_events` (install, type, outcome, created) |
| Framework | new `src/server/apps/` with `registry.ts` (each app declares key, name, category, settings schema, OAuth or key setup, which events it handles), `install.ts`, `dispatch.ts` (outbox events → app handlers in the worker) |
| Apps | `src/server/apps/slack/`, `hubspot/`, `zoho-crm/`, `salesforce/`, `google-analytics/`; move existing calendar, payment and video adapters behind the registry over time |
| WordPress | new `integrations/wordpress/` plugin folder: a shortcode and block that output feature 52's embed |
| Screens | new "Apps" page in settings: categories, search, install sheet, per-app settings and an activity log |

**How.**

1. **The registry** is code, not a database list: an app is a TypeScript module that declares its settings schema (zod), its connect method (OAuth or pasted key), and handlers for outbox events (`appointment.booked`, `appointment.cancelled`, …, the same names as feature 34's webhooks).
2. **Install** runs the OAuth flow or key check, stores credentials encrypted with the tenant key (feature 10), and records an audit event. Uninstall revokes tokens at the provider (in the worker) and deletes credentials.
3. **Dispatch** happens only in the worker, from outbox events, with feature 34's retry and disable-after-failures rules. A failing app never affects booking.
4. **First apps.** Slack (post new bookings and out-of-office to a channel); HubSpot, Zoho CRM and Salesforce (create or update a contact on booking, with only the fields the owner maps, and only for customers whose consent allows it under feature 7); Google Analytics server-side events; the WordPress plugin.
5. Each app's page shows what data it sends, in plain words, before install.
6. App credentials are never shown again after saving and never logged.

**Done when.** An owner connects Slack from the Apps page, picks a channel, and the next booking posts there within a minute; uninstalling stops it and revokes the token. A HubSpot install creates a contact on booking with only the mapped fields. The WordPress shortcode renders the booking embed on a test site.

**Needs.** Feature 34 (events and delivery rules), feature 10 (encrypted credentials), feature 7 (consent), feature 52 (embed for WordPress).

---

### 57. Browser extension

**Size:** S

**Why it matters.** Staff share booking links all day in Gmail, WhatsApp Web and LinkedIn. Opening Kalendr, finding the service and copying its link each time is slow. A toolbar button that lists their links and today's bookings saves that.

**Use.** The WebExtension APIs (Manifest V3); one build for Chrome and Edge, and Firefox where the same code works. No framework beyond React already in the repo.

**Where.**

| Change | Path |
| --- | --- |
| Extension | new `integrations/browser-extension/` (manifest, popup, background service worker) |
| Auth | feature 34's API keys, or a dedicated "extension" key kind with read-only scopes plus "create special link" |
| Routes | uses existing public API endpoints: services, today's bookings, special links (feature 45) |

**How.**

1. Sign-in: the staff member creates an extension key in their profile and pastes it once, or approves the extension through a short device-code flow. The key is stored in the extension's local storage, scoped read-only plus link creation, and can be revoked from the profile.
2. The popup shows: the person's services with "Copy link" and "Copy times for an email" (feature 52), "New single-use link" (feature 45), and today's bookings with times and first names.
3. No content scripts and no access to page contents; the extension only needs `storage` and the Kalendr API host permission. Request nothing else.
4. Publishing to the Chrome Web Store needs the owner's account: prepare the package and listing text, and let the owner submit it.

**Done when.** A staff member installs the unpacked extension, connects it with a key, copies a service link into a Gmail draft, creates a single-use link, and sees today's bookings; revoking the key in Kalendr stops it working at once.

**Needs.** Feature 34 (API keys), feature 45 (special links), feature 52 (email times snippet).
