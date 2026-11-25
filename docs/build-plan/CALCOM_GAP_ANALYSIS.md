# Cal.com gap analysis

What Cal.com offers that Kalendr does not, grouped by area so it can be added in order.
Researched 19 Nov 2026 from Cal.com's own docs, help centre, pricing page and release posts.
Every feature is described in our own words; no Cal.com code was read or copied.

**How to read the tags**

- **#N**: already in the 35-feature plan (`README.md`). Build it there.
- **#N+**: the plan has the area, but this detail is not in it. Add it to that feature's spec.
- **NEW → F36…**: not in the original 35. F36 is feature 36 in `README.md`, F37 is feature 37, and so on; they were added to the plan on 19 Nov 2026.
- **Partly**: we have some of it today; the note says what is missing.

---

## 1. Cal.com's open-source history

| When | What happened |
|---|---|
| Apr 2021 | Launched as **Calendso**, an open-source Calendly alternative. Top of Product Hunt; renamed **Cal.com** soon after. |
| 2021–2026 | **Open core.** About 99% of the code was AGPLv3. Team, organisation and business features lived in `/ee` folders under a paid licence, and self-hosters needed a licence key to switch them on. |
| 15 Apr 2026 | Cal.com went **closed source**. The public repo became **Cal.diy**, now MIT-licensed, for personal self-hosting only. |

**What Cal.diy keeps (the "open" product):** the scheduling engine, booking pages, the app framework with about 11 apps, and API v2.

**What was taken out of it (paid only now):**

- teams and organisations;
- routing forms;
- workflows;
- insights;
- SSO and SCIM;
- instant meetings;
- AI phone;
- attributes;
- audit logs;
- impersonation;
- API v1.

**Plans today:**

| Plan | Price | What it adds |
|---|---|---|
| Free | $0 | One person |
| Teams | $12 per user per month | Round robin, collective, workflows, routing, insights |
| Organizations | $28 per user per month | Sub-teams, SSO and SCIM, a company subdomain, compliance |
| Enterprise | Custom | Custom terms and support |

The developer "Platform" plan is closed to new sign-ups.

---

## 2. Services (Cal.com calls them event types or links)

| Feature | Us today | Tag |
|---|---|---|
| Staff UI to set **buffers before and after** | Columns exist, no UI or API | NEW → F36 |
| Staff UI for **minimum notice**, **booking window** (rolling days, business days or a date range) and **slot interval** | Columns exist (60 min, 90 days), no UI | NEW → F36 |
| **Several lengths on one service** (15, 30 or 60 min) with a default; price per length | One length | NEW → F36 |
| **Service colour** (light and dark) shown on calendars and the booking page | None | NEW → F36 |
| **Hidden services**: bookable by link only, not listed | None | NEW → F36 |
| **Per-service working hours** (a service uses its own schedule, not the person's) | None | NEW → F37 |
| **Restriction schedule**: a service only in certain hours, inside the person's hours | None | NEW → F37 |
| **Offset start times** (slots at :05 and :35) | None | NEW → F36 |
| **Optimised slots**: fit slots around existing bookings to cut gaps | None | NEW → F38 |
| **Only the first slot of the day** | None | NEW → F38 |
| **Event name template** for the calendar entry ("{Service} with {Customer}") | Fixed | NEW → F50 |
| **Description and banner image** on the service | Partly (description) | NEW → F36 |
| **Several location options** that the customer picks (in person, phone them, they phone us, video, their address) | Location is a branch | NEW → F36 |
| **Hide the location until confirmed** | None | NEW → F41 |
| **Phone-only booking** (no email needed) | Email or phone | Partly → F40 |
| **Lock the timezone** of a service (show slots in the business's zone) | Always the business zone | NEW → F39 |
| **Per-service week start** and **layout** | None | NEW → F39 |
| **Duplicate service** | ? | NEW → F36 |
| **Service templates for many staff** ("managed" types: an admin owns one service, each person gets a copy, and some fields are locked) | None | NEW → F48 |
| **Seats**: several customers in one slot, a remaining-seats count, an option to show other attendees, confirmation per seat | None | **#18** (group sessions) |
| **Repeating bookings** (weekly, monthly or yearly; every N; up to about 30 times) | Preview only | **#17** |
| **Instant "connect now" calls** when someone is free right now | None | **#19+** |
| **Secret or private links**: single-use, expiring, or limited uses | None | NEW → F45 |

## 3. Availability

| Feature | Us today | Tag |
|---|---|---|
| **Named schedules** ("Summer hours", "Ramadan hours"), switched per person or per service | One set of weekly rules per person and branch | NEW → F37 |
| **Several time ranges per day** (9–1 and 3–7) | Check if rules allow more than one per weekday | Partly → F37 |
| **Copy times to other days** | None | NEW → F37 |
| **Date overrides**: different hours, or closed, on a given date | Blocks only | NEW → F37 |
| **Public holidays by country**, applied automatically and opt-out per day | None | NEW → F37 |
| **Out of office** with a reason, forwarding bookings to a teammate, and a note on the booking page | Time-off blocks only | NEW → F37 |
| **Travel schedule** (a different timezone for a date range) | None | NEW → F37 |
| **Availability troubleshooter**: why is this slot not offered? (rules, busy calendar, limits, buffers) | None | NEW → F37 |
| **Import working hours from a connected calendar** | None | **#16+** |
| **Team schedule** shared by everyone in a team | None | **#20+** |
| **Busy time from external calendars** blocks slots; choose which calendars count | None | **#16** |

## 4. Booking limits

| Feature | Us today | Tag |
|---|---|---|
| **Bookings per day, week, month or year** per service | None | NEW → F38 |
| **Total booked time per day or week** per service or person | None | NEW → F38 |
| **Active bookings per customer** (e.g. at most 2 upcoming), with an option to offer rescheduling instead | None | NEW → F38 |
| **Person-level caps** across all their services | None | NEW → F38 |
| **Team or branch-wide caps** (a pool shared by many services) | None | NEW → F38 |
| **Daily capacity per branch or room** | None | NEW → F38 |

## 5. Public booking page

| Feature | Us today | Tag |
|---|---|---|
| **Month-calendar layout** (pick a date, then a time) | Slot list only | NEW → F39 |
| **Week view** and **column view** layouts, with the customer able to switch | None | NEW → F39 |
| **Detect the visitor's timezone** and let them change it | Not detected | NEW → F39 |
| **12 / 24-hour toggle** | Fixed | NEW → F39 |
| **Overlay my calendar**: the customer sees their own busy times while choosing | None | **#16+** |
| **Business profile page** listing all services, and a **team page** listing all people | Partly (business page) | NEW → F39 |
| **Brand colours**, light and dark theme, corner style, hide "Powered by" | None | **#13** |
| **Booking page banner** or announcement | None | **#13+** |
| **Prefill by URL**: name, email, phone, guests, notes, location and any question | Service, person, date, time, UTM | NEW → F40 |
| **Redirect after booking** to the business's own page, with the booking details passed on | None | NEW → F52 |
| **Success page options** (hide details, custom message) | Fixed | NEW → F52 |
| **Analytics pixels** on the booking page (Google Analytics, Tag Manager, Meta, Plausible and similar) | None | NEW → F52 |
| **"Search engines may index my page"** switch | None | **#29+** |
| **Combined-person links** (book two people together via one URL) | None | NEW → F45 |
| **Reserve a slot while the form is filled** (a short hold so nobody else takes it) | Check | NEW → F39 |

## 6. Booking questions

| Feature | Us today | Tag |
|---|---|---|
| Field types: radio, checkbox group, multi-select, URL, address, **multiple emails (guests)**, **split first and last name** | Most basic types | Partly → F40 |
| **Conditional questions** (show only when another answer matches) | None | NEW → F40 |
| **Hidden fields** filled from the URL (campaign, referrer, internal ID) | UTM only | NEW → F40 |
| **Lock a prefilled answer** so the customer can't change it | None | NEW → F40 |
| **Required or optional per question, per service** | Check | Partly → F40 |
| **Add guests** (extra email addresses), and switch guests off per service | None | NEW → F40 |
| **Verify the customer's email by code** before booking | Portal only | NEW → F40 (also **#8+**) |
| **Hide the notes field** from the calendar entry | None | NEW → F50 |
| **Booking question answers as message variables** | None | **#5+** |

## 7. Confirmation, approval and managing a booking

| Feature | Us today | Tag |
|---|---|---|
| **Needs approval** always, or only when booked within X hours, or only for free-mail addresses | Instant or request mode per service | Partly → F41 |
| **Unconfirmed bookings hold the slot or not** (a switch) | Check | NEW → F41 |
| **Reject with a reason** sent to the customer | Check | NEW → F41 |
| **Propose several times** (the customer offers 1–10 options, staff pick one) | None | NEW → F41 |
| **Cancellation reason** stored and shown in reports | Not stored | NEW → F42 |
| **Cancel or reschedule cut-off** (e.g. not within 24 h) | Not enforced | NEW → F42 (fees in **#23**) |
| **Turn off cancel or reschedule** per service | None | NEW → F42 |
| **Staff asks the customer to reschedule** ("request reschedule": the slot is freed and the customer gets a link) | None | NEW → F42 |
| **Reschedule a cancelled or past booking** from its link | None | NEW → F42 |
| **Reschedule reason** | None | NEW → F42 |
| **Preset internal notes for cancellations** | None | NEW → F42 |
| **Keep the same person when rescheduling** | Check | NEW → F42 |
| **Customer edits guests** after booking | None | NEW → F42 |

## 8. Bookings list for staff

| Feature | Us today | Tag |
|---|---|---|
| **Tabs**: upcoming, needs approval, repeating, past, cancelled | Calendar views and the today board | NEW → F43 |
| **Filters** by person, service, team, status, date and customer, plus saved filters | Partly | NEW → F43 (**#31+**) |
| **Bulk actions** on up to 100 bookings (confirm, cancel, mark no-show, reassign) | None | NEW → F43 |
| **Edit a booking's location**, **add or remove guests** | Partly (room) | NEW → F43 |
| **Reassign to another person** without cancelling, with notice to both | Partly (change person) | NEW → F43 |
| **No-show for the customer *and* for the staff member**, one or many | Customer only (check) | NEW → F43 |
| **Automatic no-show detection** from video join data | None | **#19+** |
| **History tab per booking** (who changed what, when) | Audit log exists; no per-booking view | NEW → F43 |
| **Booking source and campaign shown** on the booking | Source shown; UTM stored | Partly → F43 |
| **Report this booking as spam** (cancels it and its repeats, sends it for review) | None | NEW → F44 |
| **Book on behalf of a customer** from the staff side | Yes | — |
| **Rescheduling even when the calendar shows busy** (staff override) | Check | NEW → F43 |

## 9. Teams and assignment

| Feature | Us today | Tag |
|---|---|---|
| **Round robin** (people take turns) | First available or a chosen person | **#20** |
| Round robin **priority** per person | None | **#20+** |
| Round robin **weights** (e.g. 70% / 30%), with a daily or monthly reset | None | **#20+** |
| **Least recently booked** tie-break | None | **#20+** |
| **Fixed host plus rotating host** on one booking | None | **#20+** |
| **Round-robin groups** (one from each group joins) | None | **#20+** |
| **Collective bookings** (everyone chosen must be free; all attend) | None | **#20+** |
| **Include all current and future team members** automatically | None | **#20+** |
| **Teams inside a business** (sub-teams with their own pages) | Branches only | NEW → F53 |
| **Team member invites** by link, CSV or Google Workspace | Email invite (check) | **#11+** |
| **Private team** (hide the member list) | None | NEW → F53 |
| **Hide previous-host details** when a booking is reassigned | None | **#20+** |
| **Wrong-assignment report** with an admin review queue | None | NEW → F46 |

## 10. Routing forms (questions first, then the right service or person)

None of this exists today, and it is not in the plan.

| Feature | Tag |
|---|---|
| A form whose answers send the visitor to a **service**, an **outside link** or a **custom message** | NEW → F46 |
| **Fallback route** when nothing matches | NEW → F46 |
| **Route by staff attributes** (language spoken, speciality, gender, branch): match people whose attribute fits the answer | NEW → F46 |
| **Attribute weights** for distribution | NEW → F46 |
| **Test preview** before going live | NEW → F46 |
| **Warning for routes that can never be reached** | NEW → F46 |
| **Headless routing** (your own website form sends answers to a routing URL) | NEW → F46 |
| **Pass routing answers on** to the booking questions | NEW → F46 |
| **Routing trace** on each booking (why this person was chosen) | NEW → F46 |
| **Routing report**: answers, booked versus not booked, funnel, CSV | NEW → F46 |
| **"Submitted but didn't book"** follow-up trigger | NEW → F46 (and **#28**) |
| **CRM-owner routing** (send the visitor to their account owner) | NEW → F46 after **#27** |

## 11. Notifications and workflows

| Feature | Us today | Tag |
|---|---|---|
| Email delivery for bookings | Outbox only; not delivered | **#2** |
| SMS and WhatsApp | None | **#3**, **#4** |
| **Workflow triggers** | One fixed 24 h reminder | **#5** |
| The triggers to build: before start, after end, new, cancelled, rescheduled, needs approval, rejected, payment started or paid, no-show, form submitted, form submitted without booking | — | **#5** |
| **Workflow steps** | None | **#5+** |
| The steps to build: wait, filter (only if…), branches, webhook call, AI voice call | — | **#5+** |
| **Template variables** | None | **#5** |
| The variables to build: customer, staff, service, date and time in both zones, location, cancel link, reschedule link, rating link, no-show link, each booking answer | — | **#5** |
| **Custom date format** in templates | None | **#5+** |
| **Apply a workflow to all services, now and future** | None | **#5+** |
| **Duplicate a workflow** | None | **#5+** |
| **Verify a phone number** before sending to it | None | **#4+** |
| **Messaging credits** with a fall-back to email when they run out, and a low-balance alert | None | **#14+** |
| **Auto-translate messages** for the customer | Languages dropped | Skip (#33 dropped) |
| **Turn off default emails** per service | None | **#5+** |
| **Custom reply-to** and **sender name** | None | **#2+** |
| **Hide staff email** from the customer | Check | **#2+** |
| **Calendar invite attached** to emails (ICS) | Links only | **#2+** |
| **Customise invite title and description** | None | NEW → F50 |
| **Daily digest email** for staff | None | NEW → F56 |
| **Staff notification preferences** (email, in-app or Slack, per event) | None | NEW → F56 |
| **Browser push** to staff | None | **#32** |
| **Slack messages** (new booking, out of office) | None | NEW → F55 |
| **Business's own SMTP server** for emails | None | **#13+** |

## 12. Calendars and video

| Feature | Us today | Tag |
|---|---|---|
| Google, Outlook and Apple calendar two-way sync | None | **#16** |
| **CalDAV**, **Exchange** and an **ICS feed** to subscribe to | None | **#16+** |
| **Pick the calendars that count as busy** and **where new bookings are written** | None | **#16** |
| **Organisation-wide calendar connection** (Google Workspace / Microsoft 365 admin connects everyone) | None | **#16+** |
| Video links (Zoom, Meet, Teams, Jitsi, Whereby and others) | None | **#19** |
| **Built-in video** with a waiting room, recording and transcripts | None | **#19+** |
| **Host or guest didn't join** detection | None | **#19+** |

## 13. Payments

| Feature | Us today | Tag |
|---|---|---|
| Take payment or a deposit when booking | Ledger only, no provider | **#23** |
| **Hold a card and charge a no-show fee** later | None | **#23** |
| **Auto-charge on late cancellation** | None | **#23** |
| **Refund policy** per service | None | **#23** |
| **Payment-only after approval** | None | **#23+** |
| Several providers (Stripe, PayPal and regional ones) | None | **#23** (Razorpay or UPI for India) |

## 14. Embeds and links

| Feature | Us today | Tag |
|---|---|---|
| Inline, floating button, and pop-up on click | Link, iframe, modal | Partly |
| **Embed code builder** with a live preview and theme settings | Check | NEW → F52 |
| **Embed events** (opened, slot picked, booked, rescheduled, cancelled, failed) for the host site | One "booking completed" event | NEW → F52 |
| **Prefill and UTM forwarding** inside embeds | Partly | NEW → F52 |
| **Booking link in an email** (pick a time from the email) | None | NEW → F52 |
| **WordPress and site-builder plugins** | None | NEW → F55 |
| **QR code** of the booking link | QR on the confirmation | Partly → F52 |
| **Short links** | None | NEW → F52 |

## 15. Insights and reports

| Feature | Us today | Tag |
|---|---|---|
| Totals: created, completed, rescheduled, cancelled | None | **#26** |
| **No-show rate** for customers and for staff | None | **#26+** |
| **Average rating** and **CSAT** | None | **#26+** with F51 |
| **Most and least booked** people and services | None | **#26** |
| **Cancel and reschedule reasons** chart | None | **#26+** with F42 |
| **Routing funnel** | None | F46 |
| **Out-of-office report** | None | **#26+** |
| **Filters** by team, person, service and date presets; **CSV export** | None | **#26** |

## 16. Feedback after a visit

| Feature | Us today | Tag |
|---|---|---|
| **Rating link** in the after-visit message (1–5 plus a comment) | None | NEW → F51 |
| Ratings shown on the booking and in reports | None | NEW → F51 |
| Optional public reviews on the business page | None | **#29+** |

## 17. API, webhooks and developers

| Feature | Us today | Tag |
|---|---|---|
| Public REST API with keys (test and live), rate limits | None | **#34** |
| **OAuth apps** for third parties, client secret rotation, several redirect URLs | None | **#34+** |
| **Webhooks** | None | **#34** |
| Booking webhook triggers: created, rescheduled, cancelled, requested, rejected, reassigned, paid, payment started, location changed, title changed, no-show, and seat booked or released | — | **#34** |
| Video webhook triggers: meeting started, meeting ended, recording ready, transcript ready | — | **#34** |
| Other webhook triggers: form submitted, out of office | — | **#34** |
| Webhook **signing secret** | None | **#34** |
| **Payload templates** for webhooks | None | **#34+** |
| **Custom headers** on webhooks | None | **#34+** |
| **Versioned payloads** for webhooks | None | **#34+** |
| **Event ID for de-duplication** | None | **#34+** |
| Webhooks **per service**, per team and per business | None | **#34+** |
| **Zapier, Make and n8n** apps | None | **#34** |
| **MCP server** so AI assistants can book and manage through Kalendr | None | NEW → F54 |
| **Drop-in booking components** for other developers' sites (booker, availability editor) | None | NEW → F54 |
| **OpenAPI spec and docs site** | None | **#34+** |

## 18. App marketplace

| Feature | Us today | Tag |
|---|---|---|
| An **app store** page where a business connects apps in one place | None | NEW → F55 |
| The app types to cover: calendar, video, payment, analytics, CRM (HubSpot, Salesforce, Zoho), automation, messaging and AI agents | — | NEW → F55 |
| An **app framework** so new apps share one settings, credential and install flow | None | NEW → F55 |
| **CRM sync** (create a contact or deal on booking) | Own CRM planned | **#27+** / F55 |

## 19. Organisation, security and admin

| Feature | Us today | Tag |
|---|---|---|
| **Two-factor sign-in** for staff | None | **#6** |
| **Session timeout** setting | None | **#6+** |
| **SSO with SAML and OIDC** (Okta, Google, Microsoft) | None | NEW → F53 |
| **SCIM user provisioning** | None | NEW → F53 |
| **Verified email domains** (anyone with @clinic.com may join) | None | NEW → F53 |
| **Custom roles** with read, create, update and delete per area | Six roles, 14 permissions, overrides | Partly → F53 |
| **Staff attributes** (language, speciality, seniority) used for routing and reports | None | NEW → F46 / F53 |
| **Audit-log viewer** with filters (sign-ins, failed sign-ins, role changes, API keys, booking changes) | Log stored; no viewer | NEW → F53 (**#15+**) |
| **Sign in as a staff member** for support, with that person's consent switch | None | **#15+** |
| **Account lockout** after failed sign-ins | None | **#9+** |
| **Company subdomain** and **own domain** | Schema only | **#13** |
| **Org-wide defaults** (timezone, time format, week start, invite templates) | Partly | NEW → F53 |
| **Feature flags** for the platform admin | None | **#15** |
| **Compliance pack** (DPA, data residency statement) | Partly in `docs/SECURITY.md` | **#7+** |

## 20. Spam and abuse

| Feature | Us today | Tag |
|---|---|---|
| **Blocklist** of emails, phones or domains (bookings silently refused) | None | NEW → F44 |
| **Report booking** with an admin review queue (ignore or block) | None | NEW → F44 |
| **Bot check** on the booking form | None | **#9** |
| **Rate limits** on booking and API | Registration only | **#9** |
| **Free-mail domains need approval** | None | F41 |

## 21. AI

| Feature | Us today | Tag |
|---|---|---|
| **AI phone agent** that books, reschedules and confirms by call | None | **#30+** |
| **AI chat** on the booking page or WhatsApp | None | **#30** |
| **AI meeting notes** | None | **#19+** |

## 22. Events and companion apps

| Feature | Us today | Tag |
|---|---|---|
| **One-off events** with registration, capacity, waitlist, approval and QR check-in | Queue QR check-in exists | **#18+** |
| **Event discovery page** | None | **#29+** |
| **Staff mobile app** with push | PWA planned | **#32** |
| **Browser extension** to share a booking link from anywhere | None | NEW → F57 |
| **Import from Calendly and similar tools** | None | **#12+** |

---

## Proposed new features (F36–F57)

Each is sized like the existing plan items, and each can run as its own session.

| # | Feature | Main contents | Depends on |
|---|---|---|---|
| **F36** | **Service setup 2.0** | Staff UI for buffers, minimum notice, booking window and interval; several lengths with a price each; colours; hidden services; offset starts; location options; banner; duplicate | — |
| **F37** | **Availability 2.0** | Named schedules; several ranges a day; copy to days; date overrides; country holidays; out of office with forwarding; travel schedule; per-service and restriction schedules; troubleshooter | — |
| **F38** | **Booking limits** | Caps per day, week, month or year; total time; per-customer active cap; person, team and branch pools; first slot only; optimised slots | F36 |
| **F39** | **Booking page 2.0** | Month, week and column layouts; visitor timezone and selector; 12/24 h; locked timezone; week start; profile and team pages; short slot hold | F36 |
| **F40** | **Booking questions 2.0** | Conditional questions; hidden and prefilled fields with a lock; guests; split name; address, URL, radio and checkbox groups; email code check; phone-only booking | — |
| **F41** | **Approval rules** | Approve always, within X hours, or for free-mail; unconfirmed holds slot; reject with reason; customer proposes several times; hide location until confirmed | — |
| **F42** | **Cancel and reschedule policy** | Reasons stored; cut-offs; switch cancel or reschedule off; staff request-reschedule; reschedule cancelled or past; same-person reschedule; preset internal notes | — (fees in #23) |
| **F43** | **Bookings list** | Tabs; filters and saved views; bulk actions; edit location or guests; reassign; staff and customer no-show; per-booking history; staff busy override | — |
| **F44** | **Spam protection** | Blocklist; report booking; review queue; silent refusal | #9 |
| **F45** | **Special links** | Single-use, expiring and limited-use links; combined-person links | F36 |
| **F46** | **Routing forms** | Form builder with routes; fallback; attribute routing and weights; preview; unreachable-route warning; headless URL; trace; report; wrong-assignment queue | #20, F53 attributes |
| **F48** | **Service templates** | One admin-owned service copied to many staff or branches, with locked fields and sync | F36 |
| **F50** | **Calendar entry wording** | Event name template; invite title and description; hide notes or details; reply-to | #2, #16 |
| **F51** | **Ratings and feedback** | Rating link after the visit; score and comment on the booking; CSAT in reports | #5, #26 |
| **F52** | **Embeds and conversion** | Embed builder with preview; full embed events; email embed; redirect after booking with details; success page options; analytics pixels; short links | #34 |
| **F53** | **Enterprise and teams** | Sub-teams; private teams; SSO (SAML and OIDC); SCIM; verified domains; custom roles; staff attributes; audit-log viewer; org defaults | #6, #15 |
| **F54** | **AI and developer access** | MCP server; drop-in booking components for other sites | #34 |
| **F55** | **App marketplace** | App framework and store page; Slack; CRM sync; analytics apps; WordPress plugin | #34 |
| **F56** | **Staff notifications** | Per-person preferences (email, in-app, push); daily digest | #2, #32 |
| **F57** | **Browser extension** | Share booking links and see today's list from the browser | #34 |

(F47 and F49 are left free. Round-robin details belong in #20, and report details in #26.)

**Suggested order.** The first four waves (F36–F43) make the core scheduling engine match Cal.com. Most of them have no dependency on outside services, so they can be built before or alongside the messaging, payment and calendar features (#2–#5, #16, #23).

1. **Wave A:** F36, F37, F40, F42.
2. **Wave B:** F38, F39, F41, F43.
3. **Wave C:** F44, F45, F48, F50.
4. **Wave D:** F51, F52, F56.
5. **Wave E:** F46, F53, F54, F55, F57, after #20 and #34.

## What Kalendr has that Cal.com doesn't

Keep these as the selling points:

- walk-in queue with tokens;
- QR check-in;
- recalls and a waitlist;
- encrypted records;
- a Notion-style editor for custom visit properties;
- rooms and equipment as resources;
- handover notes and day close;
- multi-branch;
- the payment ledger;
- India-specific plans (GST, DLT SMS, UPI).
