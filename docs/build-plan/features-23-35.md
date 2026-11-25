# Features 23–35: Money, growth, and a product that feels finished

Read `STANDARDS.md` first. Each feature has six parts: **Why it matters**, **Use**, **Where**, **How**, **Done when**, **Needs**.

---

## E. Money

### 23. Online payments, deposits and policies

**Size:** XL (three sessions)

**Why it matters.** No-shows are the biggest cost a booking business carries, and a deposit is the one thing proven to cut them. Taking payment at booking also means the business is paid before the visit. Today a service has only a price label in text; no money moves through Kalendr.

**Use.** `razorpay` 2.9.8 (Orders, Checkout, Payment Links, refunds) for India; `stripe` 23.1.0 (Checkout Sessions, Connect) elsewhere.

**Where.**

| Change | Path |
| --- | --- |
| Service pricing | `services.price_minor`, `currency`, `payment_mode` (`none`, `deposit`, `full`), `deposit_minor`; keep `priceLabel` for display text |
| Policy | new `tenant_payment_policies` (free cancellation window in hours, refund rule, no-show rule) |
| Accounts | new `tenant_payment_accounts` (provider, key id, secret encrypted, webhook secret encrypted, status, mode test or live) |
| Money tables | `payments` (appointment, amount, currency, status, provider order id, provider payment id, method), `refunds` (payment, amount, reason, status, provider refund id), `payment_events` (provider event id **unique**, type, payload) |
| Adapters | new `src/server/payments/provider.ts`, `razorpay.ts`, `stripe.ts`, `fake.ts`, `policy.ts` |
| Webhooks | new `src/app/api/webhooks/razorpay/route.ts`, `stripe/route.ts` |
| Public routes | new `src/app/api/public/bookings/hold/route.ts`, `pay/route.ts` |
| Staff routes | new `src/app/api/staff/payments/*`, `payment-account/route.ts` |
| Booking flow | `src/features/booking/*` gains a payment step |
| Worker | handlers `payment-captured`, `hold-expire`, `refund-process` |

**How.**

*Session 1: accounts, prices and the hold.*

1. Each business connects **its own** payment account, so money goes straight to the business and Kalendr never holds customer funds. Razorpay: the owner pastes a key id, secret and webhook secret; store them encrypted and test them with one harmless API call before saving. Stripe: the Connect onboarding link. Changing these needs a recent second-factor check (feature 6).
2. Services get a real price and a payment mode. Show the business a live example: "Customers pay ₹200 now and ₹600 at the visit."
3. The policy has three plain settings: how long before the visit a customer can cancel for a full refund; what happens after that (no refund, or refund minus the deposit); and what a no-show forfeits. Show the policy to the customer **before** they pay, and store the exact wording they agreed to on the appointment.
4. Paying must never double-book. The order of events:
   1. The customer picks a time. The server creates an appointment in state `pending_payment` and a `resource_reservations` row in state `held`, expiring in 10 minutes. The slot leaves public availability at once.
   2. The server creates a provider order for the amount, **computed on the server from the service**, never taken from the browser. This is one of the two allowed outside calls inside a request.
   3. The browser opens the provider's checkout.

*Session break.*

*Session 2: confirming, expiring and refunding.*

5. **The webhook is the only thing that confirms a payment.** The browser's "success" callback only shows a "confirming…" screen that polls. The webhook route follows the five steps in `STANDARDS.md`: raw body, signature check, dedupe on the event id, write the event and an outbox row, return 200.
6. The worker's `payment-captured` handler, in one transaction: mark the payment captured, move the appointment to `booked`, turn the hold into `confirmed`, and queue the confirmation message. Check the amount and currency against the order before trusting it.
7. The `hold-expire` job runs every minute: any hold past its time with no captured payment is released and the appointment marked `expired`. If a payment arrives **after** the hold expired and the slot has been taken, refund it automatically and tell the customer.
8. Refunds follow the policy. Cancelling inside the free window refunds in full through the provider; outside it, the policy decides. Staff can always refund more than the policy says, with a reason and the `payments.refund` permission. Refunds are their own rows; a payment is never edited.
9. No-show: marking a visit as a no-show keeps the deposit and records it. Nothing extra is charged without the customer present.
10. Staff can send a **payment link** for an existing appointment by WhatsApp or SMS ("Pay ₹500 to confirm your visit"), with the same webhook path.

*Session break.*

*Session 3: the edges.*

11. Rescheduling keeps the payment attached to the appointment. A price difference is collected or refunded.
12. Reconcile nightly: fetch the provider's payments for the day and compare with `payments`. Mismatches go to a list for the owner. This catches a missed webhook.
13. Test mode: every account has a test/live switch, and test payments are clearly marked and left out of reports.
14. Add the provider's script and frame domains to the CSP for the booking pages only.
15. Never store card numbers, UPI ids or bank details. Kalendr stores provider ids, amounts and statuses only.

**Done when.** In test mode: a customer books a ₹800 service with a ₹200 deposit, pays by UPI, and the appointment is confirmed by the webhook, not the browser. Closing the checkout releases the slot after 10 minutes. The same webhook delivered twice confirms once. A forged webhook is rejected. Cancelling inside the window refunds ₹200; outside it does not. Two customers cannot both pay for the same slot. Changing the amount in the browser has no effect.

**Needs.** Features 1, 2, 6, 9 and 10. A Razorpay account in test mode and a Stripe account.

---

### 24. Invoices, receipts and GST

**Size:** L

**Why it matters.** Every paid visit in India needs a proper receipt, and many need a GST invoice. Businesses otherwise keep a second billing tool and type everything twice. A day-end total that matches the till is what makes an owner trust the system with money.

**Use.** `@react-pdf/renderer` 4.9.0, run in the worker.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `invoices` (number, financial year, customer, appointment, status: draft, issued, paid, part paid, void; totals; place of supply), `invoice_lines` (description, HSN or SAC code, quantity, unit price, tax rate, tax amounts), `invoice_counters` (tenant, financial year, series, last number), `credit_notes`, `tax_settings` (GSTIN, legal name, address, default tax treatment) |
| Server | new `src/server/invoicing/number.ts`, `tax.ts`, `invoice.ts`, `pdf.tsx` |
| Routes | new `src/app/api/staff/invoices/*`, `src/app/api/public/invoices/[token]/route.ts` |
| Screens | new `src/features/clinic/billing-workspace.tsx`; a "Collect payment" panel in `appointment-task.tsx` |
| Worker | handler `invoice-render` |

**How.**

1. Invoice numbers are **gapless**, per business, per financial year (April to March), per series. Issue a number only when the invoice is issued, by locking the `invoice_counters` row inside the same transaction. A rolled-back transaction must not burn a number.
2. An issued invoice is never edited or deleted. Mistakes are fixed with a credit note that points at the original, and a new invoice.
3. Tax is a pure function with tests. It handles: a business not registered for GST (no tax, labelled a receipt or bill of supply); healthcare services by a clinic, which are exempt (Notification 12/2017, entry 74), with the exemption shown; taxable services at the configured rate; CGST and SGST for a customer in the same state, IGST for another state; and prices entered including or excluding tax. Rounding is per line, in paise.
4. **Do not decide a business's tax treatment for it.** Offer a default by business type, let the owner set it per service, and tell them to confirm it with their accountant.
5. Collect payment at the desk: cash, UPI, card or bank transfer, split across methods if needed, part payment allowed. Each is a `payments` row with its method, so online and desk money share one ledger. A deposit paid online (feature 23) appears as already paid.
6. The worker renders the PDF with the business's logo and details (feature 13) and stores it in the file store. Customers get it by a tokenised link in WhatsApp or email and in the portal.
7. Day-end summary per location: totals by method, refunds, outstanding balances, and a count to compare with the cash drawer. Staff close the day; the closed total is saved and cannot change.
8. Outstanding balances show on the customer profile and the next booking.
9. Export invoices as CSV in a layout an accountant can import, with a GST summary by rate for the month.
10. Permissions: `billing.view`, `billing.collect`, `billing.refund`, `billing.close_day`. The existing `billing` role gets all four.

**Done when.** A GST-registered salon issues invoice `2026-27/0001` with CGST and SGST that add up to the paisa; a clinic's consultation invoice shows the exemption. Fifty invoices issued at once get fifty consecutive numbers with no gap. A void attempt on an issued invoice is refused and a credit note works. The day-end total equals the sum of payments by method. The PDF opens on a phone from the WhatsApp link.

**Needs.** Features 1, 10 and 23. Feature 13 for the logo.

---

### 25. Packages, memberships and coupons

**Size:** L

**Why it matters.** Prepaid packages ("10 sessions for the price of 8") and memberships bring cash in up front and lock in repeat visits. They are how salons, physiotherapists and gyms actually sell. Coupons give owners a lever for quiet days and first-time customers.

**Use.** No new library. Razorpay Subscriptions and Stripe subscriptions through the feature 23 adapters.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `packages` (name, price, credits, eligible services, valid days), `customer_packages` (customer, package, bought at, expires at), `customer_credits` (**append-only ledger**: customer package, change +/−, appointment, reason, actor), `membership_plans`, `customer_memberships` (status, period end, provider subscription id), `coupons` (code, kind: percent or fixed; limits; valid from and to; eligible services; first-visit only), `coupon_redemptions` (unique coupon + appointment) |
| Server | new `src/server/packages.ts`, `memberships.ts`, `coupons.ts` |
| Routes | new `src/app/api/staff/packages/*`, `memberships/*`, `coupons/*`, `src/app/api/public/coupons/validate/route.ts` |
| Screens | new `src/features/clinic/offers-workspace.tsx`; customer profile shows balances; booking flow gains "Use a package" and a coupon field |

**How.**

1. A package is a number of credits for chosen services, valid for a number of days. Selling one creates a payment, an invoice and one ledger row of `+N`.
2. The credit balance is **never a stored number that gets edited**. It is the sum of the ledger. Booking with a package writes `−1` in the same transaction as the appointment; cancelling inside the policy window writes `+1` back. This makes every balance explainable and impossible to corrupt with a double click.
3. Stop a balance going below zero under load: lock the `customer_packages` row before writing the ledger row.
4. Expiry: a nightly job writes an expiry row for unused credits and messages the customer 14 and 3 days before ("You have 3 sessions left, valid until 30 March").
5. Memberships: a monthly charge through the provider's subscription, giving a number of credits each period, a member price, or both. Webhooks renew, pause or end it. A failed renewal gives 7 days' grace, then pauses benefits.
6. Coupons: validate on the server at the moment of booking, inside the transaction: valid dates, service, per-customer limit, total limit, first-visit rule. Take the total-limit count under a lock so a 100-use coupon cannot be used 101 times.
7. The public validate route gives the same answer for "wrong code" and "expired code", and is rate-limited (feature 9), so codes cannot be guessed.
8. One discount per booking by default. The order is fixed and tested: member price, then coupon, then tax.
9. Customers see their packages, balances and expiry in the portal and can buy a package online.
10. Reports (26) gain: packages sold, credits outstanding (money owed in services), and coupon use.

**Done when.** A customer buys a 10-session package, books with it, and the balance reads 9 with a ledger row explaining it. Cancelling in time returns it to 10. Ten bookings at once against 1 remaining credit succeed exactly once. A coupon limited to 100 uses stops at 100 under load. A membership renewal webhook adds the month's credits once, even if delivered twice.

**Needs.** Features 23 and 24. Feature 5 for the reminders.

---

## F. Growth

### 26. Reports and analytics

**Size:** L

**Why it matters.** Owners ask four questions every week: how busy were we, how much did we make, who did not turn up, and where did customers come from. Without answers in the product they cannot tell whether Kalendr is working for them, and they have no reason to open it beyond the diary.

**Use.** `recharts` 3.10.1 through the coss chart composition, `@tanstack/react-table` 9.3.1.

**Where.**

| Change | Path |
| --- | --- |
| Queries | new `src/server/reports/bookings.ts`, `revenue.ts`, `utilisation.ts`, `customers.ts`, `sources.ts` |
| Source tracking | `appointments.source`, `utm_source`, `utm_medium`, `utm_campaign` captured at booking |
| Routes | new `src/app/api/staff/reports/[report]/route.ts`, `export/route.ts` |
| Screen | new `src/features/clinic/reports-workspace.tsx` at `/reports` |
| Digest | a workflow (feature 5) plus worker handler `weekly-digest` |

**How.**

1. Start with SQL aggregates over the live tables, scoped by `withTenant`. Do not build a separate analytics store. Add indexes for the date ranges the reports use. If a report later becomes slow, add a nightly summary table for that report only.
2. Every number is computed in the **location's timezone**, so "Monday" means the business's Monday.
3. Reports to build, each with a date range, a location filter and a staff filter:

   | Report | Shows |
   | --- | --- |
   | Overview | Bookings, revenue, new customers, no-show rate, each against the previous period |
   | Bookings | By day, service, staff member, source; lead time; busiest hours as a heat grid |
   | Utilisation | Booked hours against available hours, per staff member and room |
   | No-shows and cancellations | Rate by service, day, lead time, and whether a reminder or deposit was in place |
   | Revenue | By service, staff member, method; refunds; outstanding |
   | Customers | New against returning, rebooking rate within 30, 60 and 90 days, top customers |
   | Sources | Booking page, embed, staff, walk-in, assistant, plus UTM campaign |
   | Messages | Sent, delivered, failed, by channel; cost |

4. Each number can be clicked through to the rows behind it. A number the owner cannot check is a number they will not trust.
5. Say how each figure is worked out in one line under it ("No-show rate: no-shows ÷ visits that were due").
6. Charts follow the `dataviz` skill and `DESIGN.md`. Every chart has a table view, so it works with a screen reader and without colour.
7. Test bookings (feature 11) and test payments (feature 23) are left out everywhere.
8. Export any table as CSV. The export is a worker job for large ranges, delivered by a link. Exports are audited and need `reports.export`.
9. Permissions: `reports.view`, `reports.revenue`, `reports.export`. Practitioners see only their own numbers by default.
10. Weekly digest by email to owners on Monday morning: last week in five numbers, one thing that went well, one to look at.

**Done when.** The overview for last month matches a hand count from the database for bookings, revenue and no-shows. Utilisation for a staff member with 20 booked of 40 available hours reads 50%. A booking made from a link with `utm_campaign=diwali` appears under that campaign. A practitioner cannot see revenue for others. The CSV opens cleanly in a spreadsheet.

**Needs.** Feature 23 for revenue. Features 1 and 2 for the digest.

---

### 27. Customer profiles (CRM)

**Size:** L

**Why it matters.** The value of a booking system grows with what it remembers. A receptionist who can see at a glance that this customer prefers mornings, missed their last two visits and has an unpaid balance gives better service and protects the business.

**Use.** `@tanstack/react-table` 9.3.1.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `customer_tags`, `customer_tag_links`, `customer_notes` (author, body, pinned), `customer_segments` (name, filter jsonb), `customer_field_definitions`, `customer_field_values`, `customer_merges` (kept, merged, by, at, snapshot); `patients.blocked_at`, `patients.block_reason` |
| Server | new `src/server/customers/timeline.ts`, `segments.ts`, `merge.ts` |
| Routes | new `src/app/api/staff/customers/[id]/timeline/route.ts`, `notes`, `tags`, `merge`; `src/app/api/staff/segments/*` |
| Screens | `src/features/clinic/patients-workspace.tsx` and a new `customer-profile.tsx` |

**How.**

1. The profile opens with what staff need in the first three seconds: name, contact, next visit, last visit, visits and no-shows, balance owed, package credits, tags, and any pinned note.
2. Timeline: one list, newest first, of visits, messages, payments, forms, notes and changes. Build it as a union query with a common shape, paged by time. Filter by kind.
3. Notes are internal, attributed and dated. They are **not** clinical records: those stay in the protected records area with its own permissions. Say so in the note box for healthcare businesses.
4. Tags are free labels with a colour. Custom fields let a business add its own (allergies for a salon, class year for a tutor): text, number, date, choice.
5. Segments are saved filters built from plain conditions joined by "and": last visit before or after a date, number of visits, service used, tag, spend, has a future booking, birthday month, consent to marketing. The filter is stored as validated JSON and compiled to a parameterised query by one function. Never build SQL by joining strings.
6. Show the count as the owner builds a segment. Segments feed campaigns (feature 28) and reports.
7. Duplicates: suggest pairs with the same phone or email, or a similar name and the same birthday. Merging moves all history to the kept profile in one transaction, records a snapshot of the merged one, and can be undone for 30 days. Needs `customers.merge` and a recent second-factor check.
8. Blocking: a blocked customer cannot book online (the public page shows "please call us") and staff see a clear warning. Record who blocked them and why.
9. Lifetime value and average gap between visits are computed, not stored.
10. Search across name, phone and email stays fast: use the existing search indexes and add a trigram index if needed.
11. Everything here respects feature 7: export includes it, erasure removes it.

**Done when.** Opening a customer shows their history in one timeline in under a second with 500 entries. A segment "no visit in 90 days, more than 3 visits, consents to marketing" shows a count that matches a hand query. Merging two profiles moves every appointment and payment and can be undone. A blocked customer cannot book online.

**Needs.** Feature 7. Feature 23 for spend.

---

### 28. Campaigns and win-back

**Size:** M

**Why it matters.** The cheapest booking is from someone who has already been. Automated recall ("it's been six months since your last check-up") is the highest-return feature in every clinic and salon system studied, and it runs with no staff effort once switched on.

**Use.** No new library. Built on segments (27) and the workflow engine (5).

**Where.**

| Change | Path |
| --- | --- |
| Tables | `campaigns` (name, segment, template, channel, schedule, status), `campaign_sends` (campaign, customer, status, sent at, booked appointment id; unique campaign + customer), `marketing_preferences` (customer, channel, opted in, changed at) |
| Server | new `src/server/campaigns/audience.ts`, `send.ts`, `attribution.ts` |
| Routes | new `src/app/api/staff/campaigns/*`, `src/app/api/public/unsubscribe/[token]/route.ts` |
| Screen | new `src/features/clinic/campaigns-workspace.tsx` |
| Worker | handlers `campaign-fanout`, `campaign-send` |

**How.**

1. Two kinds. **Automated** runs daily against a rule and catches each customer once as they qualify: recall after a service's interval (set per service, such as 6 months for a dental check), birthday, win-back after 90 days away, review request after a visit, package about to expire. **One-off** sends once to a segment: a festival offer, a new service, a quiet Tuesday.
2. Ship presets per business type, switched off, so the owner turns on "6-month recall" in one click.
3. **Marketing needs its own consent**, separate from appointment messages. Only customers who opted in to marketing on that channel are included. Show the owner how many were left out and why.
4. Every marketing message carries a working unsubscribe: a link for email and SMS, "Reply STOP" for WhatsApp. Unsubscribing takes effect at once and needs no sign-in.
5. Limits that protect the business's reputation: quiet hours; at most one marketing message per customer in 7 days across all campaigns; never to a customer with a future booking for the same service; never to a blocked or erased customer.
6. WhatsApp marketing uses approved templates in the marketing category (feature 3). Show the cost estimate before sending, and count it against the plan's allowance (feature 14).
7. Fan-out is a worker job: it writes one `campaign_sends` row per customer, then sends at a steady rate. The unique key means a restart never sends twice.
8. Every message has a booking link with a campaign code. A booking within 7 days through that link is credited to the campaign. Show: sent, delivered, booked, revenue, unsubscribed.
9. Before a one-off send, show a preview with a real customer's details and require a test send to the owner's own number.
10. A campaign with a high unsubscribe or failure rate pauses itself and tells the owner.

**Done when.** Turning on "6-month recall" messages only customers who had that service six months ago, opted in, and have no future booking, and each only once. A customer who replies STOP gets no further marketing but still gets appointment reminders. A booking made from the link shows against the campaign with its revenue. Restarting the worker mid-send sends nothing twice.

**Needs.** Features 5, 7 and 27. Feature 3 for WhatsApp.

---

### 29. Search and discovery

**Size:** M

**Why it matters.** Most customers find a local business by searching. A booking page that search engines understand, with a "Book" button on the business's Google profile, brings in customers with no advertising spend. Today only the home page is in the sitemap.

**Use.** No new library. Next.js metadata, sitemap and image generation: **read the Next 16 guides in `node_modules/next/dist/docs/` first**, as these APIs have changed.

**Where.**

| Change | Path |
| --- | --- |
| Metadata | `generateMetadata` in `src/app/b/[clinicSlug]/*` |
| Structured data | new `src/lib/structured-data.ts`; a JSON-LD script in the public page |
| Sitemap and robots | `src/app/sitemap.ts`, `src/app/robots.ts` |
| Share image | a generated Open Graph image per business |
| Listing controls | `tenants.listed` (default off), `seo` jsonb (title, description) |
| Poster | new `src/features/clinic/share-kit.tsx` |
| Directory | optional `src/app/explore/*` |

**How.**

1. Each public business page gets a proper title and description ("Book an appointment at Smile Dental, Andheri West"), a canonical address (the custom domain when verified, feature 13), and a share image with the business's name, logo and colour.
2. Structured data, built by one tested function: the right business type (`Dentist`, `MedicalClinic`, `HairSalon`, `BeautySalon`, falling back to `LocalBusiness`), address, phone, opening hours, services with prices, and `AggregateRating` **only when real, published reviews exist**. Never invent or inflate a rating. Escape the JSON so a business name cannot break out of the script tag.
3. Sitemap: list active businesses that chose to be listed, with their service and staff profile pages. Build it from a `SECURITY DEFINER` function returning slugs only. Split into several files if the count passes the sitemap limit.
4. A business is **not indexed until the owner switches listing on**, and pages for paused or trial-expired businesses carry `noindex`. Booking steps, manage links, the portal and check-in pages are always `noindex`.
5. Public pages are server-rendered and fast: no layout shift, images sized, and the first screen readable without script.
6. Share kit, in Settings: the booking link with one-tap copy; ready-made links for Instagram, WhatsApp and Google Business Profile, each tagged with a source so reports (26) can tell them apart; a printable A4 and A5 QR poster in the business's colours; and an email signature line.
7. Step-by-step help for adding the booking link to a Google Business Profile, written for a non-technical owner.
8. Optional directory at `/explore`: listed businesses by city and type, with search. Build it last; it is useful only once there are enough businesses.
9. Staff and service pages get their own addresses so "Dr Rao physiotherapist Pune" can land on the right page with a book button.

**Done when.** A listed business's page passes a structured-data validator with no errors, shows a correct preview when its link is pasted into WhatsApp, and appears in the sitemap. An unlisted business does not appear and carries `noindex`. A business named `</script>` renders safely. The QR poster prints cleanly and its code opens the booking page with a source tag.

**Needs.** Feature 13 for canonical addresses. Feature 26 for source reporting.

---

### 30. AI booking assistant

**Size:** XL (three sessions)

**Why it matters.** Customers message at all hours and expect an answer. An assistant that can check real availability and book, in the customer's own language, on WhatsApp, turns missed messages into bookings. For staff, a copilot that drafts replies and finds gaps saves the front desk real time.

**Use.** `@anthropic-ai/sdk` 1.8.0. **Load the `claude-api` skill before writing any of this**: it has the current model ids, tool-use loop, streaming and caching guidance. Models: `claude-haiku-5-5` for customer chat (fast, low cost), `claude-sonnet-5-5` or `claude-opus-5-5` for staff copilot work that needs more reasoning. Set through `ASSISTANT_MODEL`.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `assistant_conversations` (channel, customer or anonymous, status, handed off at), `assistant_messages` (role, content, tool calls), `assistant_usage` (tenant, period, input and output tokens), `assistant_settings` (on/off per channel, tone, handoff rule, business facts) |
| Server | new `src/server/assistant/tools.ts`, `loop.ts`, `prompt.ts`, `guardrails.ts`, `usage.ts` |
| Routes | new `src/app/api/public/assistant/route.ts` (streaming), `src/app/api/staff/assistant/route.ts` |
| Screens | new `src/features/booking/assistant-chat.tsx`; a copilot panel in `src/features/clinic/clinic-shell.tsx`; settings in `settings-workspace.tsx` |
| WhatsApp | the inbound handler from feature 3 routes to the assistant when switched on |

**How.**

*Session 1: tools and the web chat.*

1. The assistant can do **only what its tools allow**, and every tool is an existing server function called with the tenant fixed by the server. The model never sees or chooses a tenant id, and never writes SQL. The tools:

   | Tool | Does | Needs |
   | --- | --- | --- |
   | `list_services` | Services, durations, prices | Nothing |
   | `list_staff` | Who offers a service | Nothing |
   | `find_times` | Free slots for a service, person and date range | Nothing |
   | `get_business_info` | Hours, address, policies, facts the owner wrote | Nothing |
   | `hold_and_book` | Books through the normal booking transaction | Name and phone, confirmed by the customer |
   | `find_my_bookings` | The customer's own future visits | A verified phone (OTP) |
   | `reschedule` / `cancel` | Through the normal functions and policy | A verified phone (OTP) |
   | `hand_to_person` | Opens a thread for staff | Nothing |

2. Validate every tool input with Zod before running it, and every tool runs the same permission, rate-limit and policy checks as the public API. Treat what the model asks for as untrusted input, exactly like a browser request.
3. **Confirm before changing anything.** The assistant restates the service, person, date and time and waits for a clear yes before booking, moving or cancelling.
4. The system prompt carries the business's name, type, words (from the terminology system), today's date in the location's timezone, and the rules. Business facts written by the owner go in as data, and customer messages are never treated as instructions that change the rules.

*Session break.*

*Session 2: safety, limits and WhatsApp.*

5. Hard rules, enforced in code as well as in the prompt: **no medical, legal or financial advice**; no diagnosis; no comment on other customers; no prices or policies it has not been given. Anything about symptoms or an emergency gets a fixed reply that points to the business's phone and emergency services, and hands off.
6. Hand off to a person when the customer asks for one, is upset, repeats themselves, or the assistant fails twice. The conversation appears in the staff inbox (feature 3) with a summary, and the assistant stops replying until staff hand it back.
7. Always say it is an automated assistant at the start. Never pretend to be a named member of staff.
8. Limits: cap turns per conversation and tool calls per turn; rate-limit by IP and phone (feature 9); record tokens in `assistant_usage` and stop at the plan's monthly cap (`ASSISTANT_MONTHLY_TOKEN_CAP`, feature 14) with a polite fallback to the normal booking page. Cache the fixed part of the prompt to cut cost.
9. Store conversations under the same privacy rules as messages (feature 7): included in export, removed on erasure, kept for a set time.
10. WhatsApp: inbound messages that are not button replies go to the assistant when the business has it on. Replies stay inside WhatsApp's 24-hour window and use the customer's language.

*Session break.*

*Session 3: the staff copilot.*

11. A panel for staff with tools scoped to **their own permissions**: "Find a 45-minute gap for Mrs Shah next week with any physiotherapist", "Who has not rebooked after their third session?", "Draft a reply to this message". It proposes; the staff member confirms each change with a button. It never acts on its own.
12. Log every tool call to the audit trail with the conversation id and whether a person confirmed it.
13. Test with a fake model client that replays scripted tool calls, plus a small set of real conversations run by hand before release: booking, a symptom question, an attempt to see another customer's booking, an attempt to override the rules, a language switch.

**Done when.** A customer asks on the web chat for "a haircut Saturday afternoon", is offered real free times, confirms, and the appointment appears on the schedule with source `assistant`. "What should I take for a toothache?" gets the safe reply and a handoff. Asking for someone else's booking fails without an OTP. A message saying "ignore your rules" changes nothing. Reaching the monthly cap falls back to the booking link. The copilot finds a gap and books it only after the staff member presses confirm.

**Needs.** Features 3, 5, 8, 9 and 14. An Anthropic API key.

---

## G. A product that feels finished

### 31. Staff workspace upgrade

**Size:** L

**Why it matters.** Front-desk staff use the schedule for eight hours a day. Every saved click is felt, and every slow or awkward one is resented. Speed and polish here are what make staff recommend the product rather than tolerate it.

**Use.** `@tanstack/react-query` 5.107.1, `nuqs` 2.10.3. The vendored `kloq` calendar already supports dragging.

**Where.**

| Change | Path |
| --- | --- |
| Data layer | new `src/features/clinic/queries/*` (query keys, fetchers, mutations) |
| Schedule | `src/features/clinic/schedule-workspace.tsx`, `src/components/kloq/*` |
| Command palette | `src/features/clinic/clinic-command.tsx` |
| Shell | `src/features/clinic/clinic-shell.tsx` |
| Theme | `src/app/globals.css` (dark variables already exist), a theme switch in the profile menu |
| Print | new `src/app/(staff)/print/day/page.tsx` or the equivalent route in the current layout |

**How.**

1. Move staff data fetching to react-query, one screen at a time: a stable key per list, the cache refreshed by live events (feature 32), and mutations that update the screen at once and roll back on failure. Keep `staff-snapshot-provider.tsx` working until each screen has moved.
2. **Drag to reschedule**, wired to the real reschedule route: the card moves at once; the server confirms with the version check; on a clash it snaps back with a plain message. Show an "Undo" toast for 8 seconds. Ask before notifying the customer, with the default set by the business.
3. Drag the bottom edge to change length. Drag across staff columns to reassign (feature 20).
4. Views: day by staff member, day by room, week, and a list. View, date, filters and the open appointment live in the address bar with `nuqs`, so a link opens the same screen and Back works.
5. Command palette (Ctrl or Cmd + K) on **real data**, replacing the demo list: find a customer by name or phone, jump to a date, start a booking, open settings. Results come from a debounced server search.
6. Keyboard shortcuts for the daily actions: `N` new appointment, `T` today, arrow keys to change day, `/` search, `?` shows the list. Never capture keys while typing in a field.
7. Bulk actions on the list view: select several appointments to message, move to another staff member, or cancel with a reason (for a staff member off sick).
8. Phone layout: a bottom bar with Today, Schedule, Customers, Messages and More; the day view as a vertical list; large touch targets.
9. Dark mode: a switch with light, dark and system. Check every screen for contrast in both.
10. Loading skeletons that match the final layout, so nothing jumps.
11. Print the day sheet: one page per staff member with times, customers, services and notes, laid out for paper.
12. A long day stays smooth: render only visible rows in long lists, and keep typing and dragging at 60 frames a second with 300 appointments on screen.

**Done when.** Dragging an appointment to a new time updates the server and can be undone; dragging onto a clash snaps back with a reason. The palette finds a real customer by part of their phone number. Reloading keeps the same view and date. Every daily action can be done by keyboard. The schedule works one-handed on a 360px phone and reads well in dark mode.

**Needs.** Feature 32 for instant refresh across screens (works without it, with a refresh on focus).

---

### 32. Live updates, alerts and installable app

**Size:** L

**Why it matters.** Two receptionists and a doctor look at the same diary. If one books and the others do not see it until they refresh, they double-handle customers and stop trusting the screen. Staff also need to know at once when an online booking or message arrives, even with the tab closed.

**Use.** PostgreSQL `LISTEN`/`NOTIFY` with server-sent events; `web-push` 4.0.0; `@serwist/next` 9.5.13 for the service worker (**confirm it works with `next build --webpack` and the Next 16 docs before relying on it**; a hand-written service worker is the fallback).

**Where.**

| Change | Path |
| --- | --- |
| Event bus | new `src/server/live/notify.ts`, `listener.ts` |
| Stream | new `src/app/api/staff/events/route.ts`; public stream for the queue screen (feature 22) |
| Client | new `src/features/clinic/use-live-events.ts` |
| Alerts | tables `staff_notifications` (staff member, kind, title, link, read at), `push_subscriptions` (staff member or customer, endpoint, keys encrypted), `notification_preferences` |
| Routes | new `src/app/api/staff/notifications/*`, `push/subscribe/route.ts` |
| App shell | `src/app/manifest.ts`, the service worker, an install prompt |
| Worker | handler `push-send` |

**How.**

1. When a transaction changes something others should see, it calls `pg_notify` on one channel with a tiny payload: tenant id, kind (`appointment`, `queue`, `message`, `notification`) and the row id. **No personal data goes in the payload.** The notice is sent only if the transaction commits.
2. Each app server holds **one** dedicated database connection that listens, and fans events out in memory to the open streams for that tenant. This connection is separate from the pool and reconnects with backoff.
3. `/api/staff/events` is a server-sent events stream. It checks the staff session, sends only that tenant's events, sends a heartbeat every 25 seconds, and closes cleanly when the client goes. Read the Next 16 guide on streaming responses first.
4. The browser treats an event as "this changed, fetch it again": it invalidates the matching react-query key (feature 31). It never trusts the event for data, so permissions are still enforced by the normal fetch.
5. On reconnect, refetch what is on screen, since events may have been missed. Fall back to polling every 30 seconds if the stream cannot connect.
6. In-app alerts: a bell with a count. Kinds: new online booking, booking request to approve, customer message, cancellation, payment received, waitlist filled, "Needs a person" item. Each staff member chooses which they get and how.
7. Push alerts: staff opt in from their profile, **never on first load**. The subscription is stored encrypted. The worker sends the push with a short, non-personal text ("New booking at 4:30 pm") and a link. Remove subscriptions the push service reports as gone.
8. Installable app: complete the manifest (name, icons, colours, start address), add an install prompt after a few uses, and cache the app shell so it opens instantly.
9. Offline: staff can open today's schedule read-only from the last sync, with a clear "Offline: showing 9:42 am" banner. No changes are queued offline in this version; say so plainly. **Never cache customer data in a shared cache**, and clear the cache on sign-out.
10. Customers can install their portal and get push reminders as a free extra channel.
11. Load: check 200 open streams on one server, and that a deploy reconnects everyone without a storm (random delay before reconnecting).

**Done when.** A booking made in one browser appears in another within two seconds without a refresh. Staff from business B never receive an event from business A (tested). A push alert arrives on a phone with the tab closed and opens the right appointment. The app installs to a phone's home screen and opens today's schedule offline, read-only. Signing out clears cached data.

**Needs.** Features 1 and 10. Feature 31 for the query layer.

---

### 33. Languages

> **Dropped by the owner on 2026-11-12. Do not build.** The section is kept for reference only.

**Size:** L

**Why it matters.** Most of Kalendr's first customers serve people who would rather read Hindi, Marathi or Tamil than English. A booking page and a reminder in the customer's own language lifts completion and cuts missed visits. It also opens every market beyond English speakers.

**Use.** `next-intl` 4.15.0. **Check its guide for the Next.js version in this repo, and how it works with `src/proxy.ts`.**

**Where.**

| Change | Path |
| --- | --- |
| Messages | new `messages/en-IN.json`, `hi-IN.json`, then others |
| Setup | new `src/i18n/*` (request config, locale list, helpers) |
| Locale choice | `src/proxy.ts` for public pages; `patients.preferred_language`; `tenants.default_language`, `tenants.languages` |
| Terminology | `src/lib/terminology.ts` gains per-language words |
| Templates | `message_templates.language` (feature 3); email templates per language |
| Public screens first | `src/features/booking/*`, `src/features/business/*`, `src/features/portal/*`, `src/app/manage/*` |

**How.**

1. Order of work: customer-facing screens and messages first, because they reach the most people. Staff screens second.
2. Languages: English (India) and Hindi first. Then Marathi, Tamil, Telugu, Bengali, Gujarati and Kannada. Each business picks which it offers; the customer's choice is remembered.
3. Choose the language for a public page in this order: the customer's saved choice, a `?lang=` in the link, the browser's language if the business offers it, then the business's default. Show a language switch in the page header.
4. Move every piece of text on customer screens into message files. No sentence is built by joining fragments: use full sentences with placeholders and proper plural rules, since word order differs between languages.
5. The terminology system and translation must work together: "Book with your {staffWord}" needs the staff word for that business type **in that language**. Extend `src/lib/terminology.ts` so each word set has an entry per language, with a grammatical form where a language needs it.
6. Dates, times, numbers and money use `Intl` with the locale and the location's timezone. Keep the 12-hour or 24-hour choice per business.
7. Messages: each workflow step has a template per language; the customer's preferred language picks one, falling back to the business default. WhatsApp templates are approved per language (feature 3).
8. Text a business writes itself (service names, descriptions, policies) can be given in each language the business offers, falling back to the default. Do not machine-translate it silently; offer a "suggest a translation" button the owner reviews.
9. Have every language checked by a fluent speaker before release. A wrong word on a medical booking page costs trust.
10. Layout: check long words do not break buttons, and that Indic scripts have enough line height. Set `lang` on the page for screen readers.
11. Add a test that fails when a key is missing from any language file, and a lint rule against hard-coded text in customer screens.

**Done when.** A customer opens a salon's page in Hindi, books, and gets a Hindi WhatsApp confirmation with the date written in Hindi; a clinic's page in Hindi uses the Hindi word for doctor. Switching language keeps the booking in progress. A missing key fails the build. Staff screens are unchanged in English.

**Needs.** Features 3 and 5 for per-language messages.

---

### 34. Public API and webhooks

**Size:** L

**Why it matters.** Larger businesses and their developers need to connect Kalendr to what they already run: a website, a CRM, accounting, a hospital system. An API and webhooks turn Kalendr from an app into a platform, and let tools like Zapier, Make and n8n connect it to thousands of others with no work from Kalendr.

**Use.** `zod-openapi` 6.0.2, `@scalar/nextjs-api-reference` 0.12.17.

**Where.**

| Change | Path |
| --- | --- |
| Tables | `api_keys` (name, prefix, key hash, scopes, last used, expires, revoked), `webhook_endpoints` (address, secret encrypted, events, status), `webhook_deliveries` (endpoint, event id, attempt, status code, duration, next try) |
| Auth | new `src/server/api-key-context.ts` |
| Routes | new `src/app/api/v1/*` (services, staff, availability, appointments, customers) |
| Spec and docs | new `src/server/openapi.ts`, `src/app/api/v1/openapi.json/route.ts`, `src/app/developers/page.tsx` |
| Screens | a "Developers" section in `settings-workspace.tsx` |
| Worker | handler `webhook-deliver` |

**How.**

1. API keys: shown **once** when created, stored as a SHA-256 hash, with a visible prefix (`kal_live_…`, `kal_test_…`) so a leaked key can be identified. Each has scopes (`appointments:read`, `appointments:write`, `customers:read` and so on), an optional expiry, and can be revoked at once. Creating a key needs the owner role and a recent second-factor check.
2. `getApiKeyContext` resolves the key to a tenant and scopes, then everything runs through `withTenant` exactly like a staff request. The API calls the **same server functions** as the staff routes, so rules, audit and idempotency are shared, not copied.
3. The first version is small and stable: list services and staff; get availability; create, read, reschedule and cancel appointments; find and create customers. Version in the path (`/api/v1`). Never break v1; add fields, do not remove them.
4. Conventions: cursor paging; ISO 8601 times with offsets; the existing error shape; `Idempotency-Key` required on every create; rate limits per key with the standard headers (feature 9).
5. The OpenAPI document is **generated from the Zod contracts**, so the docs cannot drift from the code. Serve it at `/api/v1/openapi.json` and render it at `/developers`.
6. Webhooks out: a business adds an address and picks events (`appointment.created`, `.rescheduled`, `.cancelled`, `.completed`, `.no_show`, `payment.captured`, `customer.created`). Each event writes an outbox row; the worker delivers it.
7. Sign each delivery: header `X-Kalendr-Signature` with a timestamp and an HMAC-SHA256 of the timestamp and body using the endpoint's secret, so the receiver can verify it and reject replays. Document the check with sample code.
8. Delivery rules: 10-second timeout; retry with growing delays for 24 hours; disable an endpoint after repeated failure and email the owner. Each delivery is logged with status and timing, and can be resent from the screen.
9. **Guard against requests to internal addresses**: refuse private, loopback and link-local addresses, resolve the name and check the address before connecting, do not follow redirects, and require HTTPS.
10. Payloads carry ids and the changed fields, with a version. Keep personal data to what the event needs.
11. A "Send test event" button and a delivery log make setup possible without support.
12. Limits by plan (feature 14).

**Done when.** A script with an API key lists availability and books an appointment that appears on the schedule and in the audit trail as that key. A key without `appointments:write` is refused. A webhook receiver gets a signed `appointment.created` within seconds and verifies the signature with the documented code. A failing endpoint is retried and then disabled. A webhook address pointing at `http://127.0.0.1` is refused. The docs page lists every route from the generated spec.

**Needs.** Features 1, 6, 9 and 10.

---

### 35. Monitoring, browser tests and CI

**Size:** L. **Build this first.**

**Why it matters.** Every other feature is safer and faster to build once this exists. Without error reports, nobody knows a booking failed until a customer complains. Without browser tests and CI, each new feature risks quietly breaking booking, the one thing that must never break.

**Use.** `@sentry/nextjs` 11.12.0; `@vercel/otel` 2.3.0 or `@opentelemetry/sdk-node` 0.301.1; `pino` 10.4.0; `@playwright/test` 1.65.0; `@axe-core/playwright` 4.14.0; `knip` 6.45.1.

**Where.**

| Change | Path |
| --- | --- |
| Environment | new `src/server/env.ts` (one Zod schema for every variable) |
| Logging | new `src/server/logger.ts`; used by `src/server/http.ts` and the worker |
| Tracing and errors | new `instrumentation.ts` and the Sentry config files the current Next 16 guide calls for |
| Health | new `src/app/api/health/route.ts`, `src/app/api/ready/route.ts` |
| Browser tests | new `e2e/*`, `playwright.config.ts` |
| CI | new `.github/workflows/ci.yml` |
| Container | new `Dockerfile`, `.dockerignore`; `compose.yaml` gains an `app` and a `worker` service |
| Docs | new `docs/OPERATIONS.md` |

**How.**

1. **Environment check.** One Zod schema reads every variable at startup and stops the app with a clear message naming what is missing or wrong. Production refuses unsafe values: preview mode on, a default secret, a missing encryption key. Replace scattered `process.env` reads with imports from `env.ts`.
2. **Logging.** `pino` writing JSON. Every line carries the request id, tenant id and route. A redaction list removes phone, email, name, token, code and body fields even if someone logs them by mistake, and a test proves it. `routeErrorResponse` logs through this.
3. **Errors.** Sentry on the server, the browser and the worker, with the request id and tenant id attached and personal data scrubbing on. Send no request bodies. Errors the user caused (validation, permission) are not reported; unexpected ones are. Add Sentry's addresses to the CSP.
4. **Tracing.** OpenTelemetry through `instrumentation.ts`: a trace per request covering the database calls, and a trace per worker job linked to the request that queued it. Read the Next 16 instrumentation guide first.
5. **Health.** `/api/health` says the process is up. `/api/ready` checks the database and that migrations are current. Neither reveals versions or internals to the public.
6. **Worker signals** (with feature 1): heartbeat age, queue depth, oldest pending item, dead-letter count. Alert when the heartbeat is older than 2 minutes, the oldest item is older than 10, or dead letters rise.
7. **Browser tests** with Playwright against a real local database, seeded per run:

   | Journey | Checks |
   | --- | --- |
   | Customer books | Pick service, person, time; fill the form; see confirmation; the appointment exists |
   | Customer manages | Open the manage link; reschedule; cancel |
   | Staff day | Sign in; book; check in; complete; mark a no-show |
   | Owner sets up | Register; finish setup; public page is live |
   | Isolation | Staff of business B cannot open business A's appointment by its address or through the API |
   | Double booking | Two browsers take the same slot; exactly one succeeds |

   Run each on a desktop and a phone-sized screen, and run an `axe` accessibility scan on every page visited. Serious findings fail the run.
8. **CI** on every push and pull request: install with the locked versions; lint; typecheck; unit tests; a PostgreSQL 18 service container for integration tests using the non-owner role; build; then the browser tests against the built app. Upload the Playwright report when a run fails. Cache pnpm and the Playwright browsers. Match the Node and pnpm versions in `package.json`.
9. Add `knip` to find unused files, exports and dependencies; fix what it finds and keep it in CI. Add a dependency audit that fails on high-severity findings.
10. **Container.** A multi-stage `Dockerfile` producing a small image that runs as a non-root user. One image, two commands: the web app and the worker. Migrations run as a separate release step with the owner role, never at app start.
11. **Runbook** in `docs/OPERATIONS.md`: how to deploy, roll back, run migrations, restore a backup, rotate a secret, and what each alert means and what to do. Do a real restore of a backup into an empty database once and write down how long it took.
12. Add a release checklist that includes `pnpm check`, the database tests and the browser tests.

**Done when.** Starting the app with a missing secret stops with a message naming it. A forced server error shows in Sentry with the request id and no personal data. A log line containing a phone number is redacted (tested). CI runs on a pull request and blocks a merge when the double-booking browser test fails. `/api/ready` fails when the database is down. The container image runs both the app and the worker. A backup has been restored once, with the steps written down.

**Needs.** Nothing. A Sentry project and GitHub Actions on the repository.
