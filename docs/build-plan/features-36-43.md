# Features 36–43: Scheduling engine to Cal.com's level

Read `STANDARDS.md` first. Each feature has six parts: **Why it matters**, **Use**, **Where**, **How**, **Done when**, **Needs**.

These features came from the Cal.com comparison in [CALCOM_GAP_ANALYSIS.md](CALCOM_GAP_ANALYSIS.md). They describe the behaviour in our own words; do not copy Cal.com source. None of them needs an outside account, so they can start any time after stage 1.

Migrations in this group start at `0026`. When several are built at once, renumber at merge time as the README's build rules say.

**One rule for all eight.** Every slot rule (buffers, notice, window, overrides, holidays, limits) is applied in **one place**: a pure function `offerableSlots(input)` in a new `src/server/slot-engine/` folder. The public availability route, the staff "openings" list, the reschedule check and the booking commit all call it. The commit re-runs it inside the booking transaction, so a slot that was offered a minute ago and is no longer allowed is refused there. No screen applies a rule of its own.

---

## H. Scheduling engine to Cal.com's level

### 36. Service setup 2.0

**Size:** L

**Why it matters.** The `services` table already stores buffers, minimum notice (60 minutes), how far ahead customers can book (90 days) and the slot interval, but no screen or route lets a business change them, so every business runs on the defaults. A salon needs a 10-minute clean-up after each cut; a clinic will not take same-day bookings; a tutor offers 30, 45 and 60 minutes at different prices. Today each of those needs a separate service or can't be done.

**Use.** No new library. The colour picker is the coss `Select` with swatches, not a free colour wheel.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0026_service_setup`) | `services`: `booking_window_kind` (`rolling_days`, `business_days`, `date_range`), `booking_window_from`, `booking_window_through`, `start_offset_minutes`, `color_light`, `color_dark`, `visibility` (`listed`, `hidden`), `slug` (unique per tenant), `banner_media_id`; new `service_durations` (service, minutes, price minor, is default, sort order); new `service_location_options` (service, kind: `in_person`, `we_call`, `they_call`, `video`, `their_address`; location id when in person; note; sort order) |
| Server | `src/server/public-catalog.ts`, `src/server/appointment-repository.ts`, new `src/server/slot-engine/service-rules.ts`, new `src/server/services-admin.ts` |
| Routes | `src/app/api/staff/services/route.ts` and new `src/app/api/staff/services/[id]/route.ts` (GET, PATCH with `expectedVersion`, POST `duplicate`); `src/app/api/public/availability/route.ts` takes `durationMinutes` |
| Contracts | `src/server/contracts.ts`: service setup schema with zod |
| Screens | new `src/features/clinic/service-editor.tsx` (a coss `Drawer` with tabs: Basics, Lengths and prices, Timing, Where, Look); `settings-workspace.tsx` lists services; `src/features/booking/service-card.tsx` and `booking-flow.tsx` show lengths and the location choice |

**How.**

1. **Timing tab.** Plain fields with units, each with a sentence that explains it in the business's own case:
   - Buffer before and after (0–240 minutes). "Blocks 10 minutes after each visit for cleaning. Customers don't see it."
   - Minimum notice in minutes, hours or days (stored as minutes, up to 90 days).
   - Booking window: "up to N days ahead", "up to N business days ahead" (skips days the business is closed), or "only between these dates".
   - Slot interval (5, 10, 15, 20, 30, 60 or "same as the length").
   - Start offset (0–55 minutes): slots start at :05 or :10 past instead of on the hour.
   DB checks mirror zod: buffers 0–240, interval > 0, offset < interval, window dates in order.
2. **Lengths and prices.** A service can offer one to six lengths, each with its own price, and exactly one default (a partial unique index on `is_default`). The current `duration_minutes` and `price_minor` become the default row in the migration so nothing changes for existing services. The customer picks a length on the service card before the time; slots are computed for that length. The appointment stores the length and price it was booked at, as today.
3. **Where.** A service lists one or more location options. In person lists the branches it is offered at (reusing `service_locations`). "We call you" asks for the customer's phone; "You call us" shows the business number after booking; "Video" is a placeholder until feature 19 creates the link; "Your address" asks for an address (encrypted like other answers). With several options the customer chooses one on the booking form; with one it is shown, not asked. Store the choice on the appointment as `location_kind` and `location_detail` (encrypted when it is the customer's address).
4. **Look.** Colour for light and dark mode, chosen from the calendar palette in `src/components/kloq/lib/event-palette.ts`, so the staff calendar uses the service colour. A description (plain text with line breaks; no HTML) and an optional banner from the media library.
5. **Hidden services** are not listed on the business page or in the catalog API, but book normally from their direct link `/book/[business]/[service-slug]`. Staff see a "Hidden" badge and a "Copy link" item.
6. **Duplicate** copies the service with "(copy)" in the name, a new slug, its lengths, location options, people and forms, and opens it in the editor. It is one transaction.
7. **The slot engine** gains `service-rules.ts`: given a service, length, day and timezone, it returns the candidate starts with buffers, notice, window and offset applied. Buffers widen the busy span used for overlap checks on both sides, so a booking with a 10-minute after-buffer also blocks a booking that would start inside those 10 minutes. Unit-test it across a DST change (a tenant in `Europe/London`) and a business-day window that crosses a closed weekend.
8. Changing timing never moves existing bookings. Show "Applies to new bookings only" under the Timing tab.
9. The editor uses `ChoiceField`-style selects, keeps one row of buttons (Save, Duplicate in the ⋯ menu, Hide in the ⋯ menu), and becomes a bottom sheet on phones.

**Done when.** A business sets a 15-minute after-buffer, a 24-hour notice and a 30-day window, and the public page stops offering slots that break any of them; a direct API booking that breaks one is refused with a clear error. A service with 30/45/60-minute lengths shows three prices and offers different slots for each. A hidden service is absent from the business page but books from its link. Duplicating a service gives an editable copy in one click.

**Needs.** Nothing outside this group. Feature 19 fills in video links later.

---

### 37. Availability 2.0

**Size:** L

**Why it matters.** Today each person has one weekly pattern per branch, plus blocks of time off. Real life is messier: a dentist does 9–1 and 3–7, works a different pattern on alternate Saturdays, is off on public holidays, spends a week in another city, and wants a different pattern for one service. When a slot is missing, staff have no way to find out why and call support.

**Use.** `date-holidays` (open-source country, state and religious holiday data that works offline; check its current version and licence before adding) for public holidays. No other new library.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0027_availability_schedules`) | new `availability_schedules` (practitioner, name, timezone, is default); `availability_rules.schedule_id` (backfilled with one "Working hours" schedule per person and location); new `availability_overrides` (schedule, date, ranges as jsonb or "unavailable"); new `holiday_settings` (tenant, country, region, opted-out holiday ids per year); new `travel_periods` (practitioner, from, to, timezone); `services.schedule_id`, `services.restriction_schedule_id` |
| Out of office | extend feature 20's `time_off` with `public_note` and `forward_to_practitioner_id`; if feature 20 is not built yet, create `time_off` here with feature 20's columns |
| Server | new `src/server/slot-engine/working-hours.ts`, `holidays.ts`, `explain.ts`; `src/server/appointment-repository.ts` |
| Routes | `src/app/api/staff/availability/*` (schedules, overrides, copy, travel), new `src/app/api/staff/availability/explain/route.ts`, new `src/app/api/staff/holidays/route.ts` |
| Screens | `src/features/clinic/availability-settings.tsx`, `hours-editor.tsx`, a new "Why no slot?" sheet reachable from `schedule-workspace.tsx` and the person's settings |

**How.**

1. **Named schedules.** Each person has one or more schedules ("Working hours", "Summer", "Home visits"); one is the default. A schedule is a weekly pattern plus overrides, in its own timezone. Existing rules become the default schedule in the migration.
2. **Several ranges a day.** The rules table already allows more than one row per weekday; the editor must show them: each day has a list of ranges with "+" to add and "×" to remove, and rejects overlapping ranges (zod, plus a check in the server before insert because the DB cannot easily check overlap across rows; use an exclusion constraint on `tsrange` per schedule and weekday).
3. **Copy times** from one day to others with a small menu ("Copy to… Mon Tue Wed …", "All weekdays").
4. **Date overrides.** Pick one or more dates on a calendar and either set different ranges or mark the day unavailable. Overrides win over the weekly pattern. Past overrides are kept but hidden.
5. **Public holidays.** The owner picks a country (default from the tenant's country) and optional state. Holidays for the next 12 months are listed with a switch each; on means "closed". Holidays are worked out on the fly by `holidays.ts` from the library, not stored, except the opt-outs. A person can still work a holiday by adding an override.
6. **Out of office.** A person (or a manager) sets dates, a reason from a short list, an optional note shown on the booking page ("Back on 3 December"), and optionally a teammate to forward new bookings to. While out, their personal booking link shows the note and, with forwarding, the teammate's slots for the same service.
7. **Travel.** A date range with a different timezone. During it the weekly pattern is read in the travel timezone ("9–5 wherever I am"). Show the converted hours next to the range so the person can check.
8. **Per-service schedule.** A service can use a named schedule instead of the person's default ("Home visits only on Tuesday afternoons"). A **restriction schedule** narrows any person's hours for that service: the offered time is the overlap of the person's hours and the restriction.
9. **The order the engine applies rules,** in `working-hours.ts`, for one person and one day: schedule (service's, else the person's default) → travel timezone → override for that date → public holiday → out of office → time-off blocks → restriction schedule. Write each step as a small pure function and test each, then test the whole chain on a table of real cases.
10. **"Why no slot?"** Staff pick a person, service and date. `explain.ts` runs the same chain step by step and returns, for each 15-minute step of the day, the first rule that removed it: "outside working hours", "holiday: Diwali", "out of office", "already booked", "buffer after 11:00 visit", "within minimum notice", "beyond booking window", "daily limit reached" (feature 38), "busy in Google Calendar" (feature 16). Show it as a timeline with colour bands and plain reasons. It is read-only and needs the `schedule:read` permission.
11. Everything saves with a version check; two managers editing the same schedule get a clear "someone else changed this" message.

**Done when.** A person can have 9–1 and 3–7 on Monday and the page offers nothing between 1 and 3. Marking 25 December unavailable removes that day only. Choosing India and turning Diwali off keeps the business open on Diwali. A week of travel to Dubai shifts that week's slots by the right offset across the boundary. The "Why no slot?" sheet names the correct reason for each of the eight cases above in a test.

**Needs.** Feature 20 shares `time_off` (either can come first). Features 16 and 38 add their reasons to the explainer when they land.

---

### 38. Booking limits

**Size:** M

**Why it matters.** Owners want to cap work, not just shape hours: "no more than 8 facials a day", "each customer can hold only 2 future bookings", "Dr Rao sees at most 20 people a day across all services", "this room can host 12 sessions a day". Without limits, a popular person is overbooked and customers hoard slots.

**Use.** No new library.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0028_booking_limits`) | new `booking_limits` (tenant; scope: `service`, `practitioner`, `location`, `resource`, `team`; scope id; measure: `count` or `minutes`; period: `day`, `week`, `month`, `year`; max value); `services.max_active_per_customer`, `services.offer_reschedule_when_capped`, `services.first_slot_only` |
| Server | new `src/server/slot-engine/limits.ts`; booking commit in `src/server/appointment-repository.ts` |
| Routes | `src/app/api/staff/services/[id]/route.ts` (limits for a service), new `src/app/api/staff/limits/route.ts` (person, branch, room, team) |
| Screens | a "Limits" tab in `service-editor.tsx` (feature 36); a "Limits" section in the person, branch and room settings |

**How.**

1. A limit says "at most N bookings" or "at most N minutes booked" per day, week, month or year, for one service, one person, one branch, one room or a team pool (all people in a team, from feature 53, or a hand-picked list until then). Periods follow the business's timezone and its week start.
2. Counting: confirmed and requested bookings count; cancelled, declined and expired ones do not. Whether requested bookings count follows feature 41's "unconfirmed holds the slot" switch.
3. **Showing slots.** `limits.ts` loads the counts for the visible range in one grouped query and removes every slot on a day (or week, or month) whose limit is already reached. When a limit is reached, the day shows as full, not as "no hours".
4. **At commit**, the check runs inside the booking transaction. Take a transaction-scoped advisory lock on the limit key (`tenant`, scope, scope id, period start), recount, then insert. Two people taking the last place at the same moment: exactly one succeeds. Test this with two parallel transactions.
5. **Per customer.** "A customer can hold at most N future bookings of this service." The check matches the customer by their verified email or phone. When capped, the page says so plainly and, if `offer_reschedule_when_capped` is on, links to move their existing booking instead.
6. **First slot only.** When on, each person offers only their earliest free slot each day (for businesses that want tight, gap-free days).
7. Staff booking from the workspace see the limit as a warning they can override with a reason, recorded in the audit log (without free-text notes in metadata; the reason is a fixed choice).
8. The explainer from feature 37 reports "daily limit reached (8 of 8)".

**Done when.** A service limited to 3 a day stops offering slots after the third booking that day, in the business's timezone. Two simultaneous attempts at the last place give one booking and one clear refusal. A customer at their 2-booking cap is offered to reschedule instead. A person's 20-a-day cap applies across all their services. Staff can override with a recorded reason.

**Needs.** Feature 36 for the service editor tab. Feature 37 for the explainer reason. Feature 53 for real team pools (a hand-picked list works before it).

---

### 39. Booking page 2.0

**Size:** L

**Why it matters.** The booking page is where customers decide. Today it shows one layout, in the business's timezone and its clock format. A customer abroad booking a video visit sees the wrong times; people who book a week at a glance want a week view; teams want one page that lists everyone. Losing a slot while typing the form is the most annoying failure of all.

**Use.** No new library. Timezone names from `Intl.supportedValuesOf("timeZone")`.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0029_booking_page`) | `services.layouts_enabled` (array of `month`, `week`, `column`), `services.default_layout`, `services.lock_timezone`, `services.week_start`; `tenants.default_clock` (`12h`, `24h`, `auto`); new `slot_holds` (tenant, service, practitioner, starts at, ends at, hold token hash, expires at) |
| Server | `src/server/public-catalog.ts`, `src/server/business-page.ts`, new `src/server/slot-holds.ts`; the slot engine treats live holds as busy |
| Routes | `src/app/api/public/availability/route.ts` (returns UTC; accepts a range for week view), new `src/app/api/public/holds/route.ts` (POST to hold, DELETE to release) |
| Pages | `src/app/b/[slug]/page.tsx` (profile), new `src/app/b/[slug]/team/page.tsx`, new `src/app/b/[slug]/[person]/page.tsx` |
| Screens | `src/features/booking/slot-picker.tsx` split into `month-view.tsx`, `week-view.tsx`, `column-view.tsx`; a timezone select and a 12/24-hour switch in the picker header |

**How.**

1. **Layouts.** Month (calendar with available days marked, slots for the chosen day beside it), week (seven columns of slots), and column (several days side by side, good on desktop). The business chooses which are allowed per service and the default; the customer switches with a segmented control. On phones, week and column fall back to month. The choice is kept in the address with `nuqs` so a shared link opens the same view.
2. **Timezone.** The API always returns UTC. The page reads the visitor's timezone from the browser and shows times in it, with a searchable select to change it. If the visitor's zone differs from the business's, show a line: "Times shown in Dubai time (1 h 30 m behind the clinic)". For in-person services the business can **lock** the timezone to the branch's, because an in-person visit only makes sense in local time.
3. **Clock.** 12- or 24-hour from the visitor's locale by default, with a small switch; the business can set a default.
4. **Week start** per service (Monday or Sunday), defaulting to the tenant's.
5. **Slot hold.** When the customer picks a time, the page asks for a 5-minute hold. The server inserts a `slot_holds` row inside a transaction that runs the same overlap check as a booking, returns a hold token (256-bit, stored hashed), and the slot disappears for everyone else. The booking commit converts the hold. Expiry is done by the existing `slot-hold expiry` job from feature 1, and the engine also ignores holds past `expires_at`, so a missed job never blocks a slot. One live hold per browser session; picking another time releases the first. Feature 23's payment hold reuses this table.
6. **Profile page** `/b/[slug]`: business name, logo, about, branches with maps links, people (photo, title, next free time) and listed services grouped by category. **Team page** `/b/[slug]/team`: everyone, each with their services. **Person page** `/b/[slug]/[person]`: one person's services and next openings.
7. Pages are server-rendered with cached catalog data and stream the slot list, so first paint is fast; check against the Next 16 caching docs in `node_modules/next/dist/docs/` before choosing the cache API.
8. Accessibility: each slot is a button with its full date and time as its name; the grid is navigable with arrow keys; the timezone change is announced.

**Done when.** A visitor in Dubai booking a video visit sees times in Dubai time, and the clinic sees the right local time. The same in-person service with the lock on shows clinic time to everyone. A customer can switch between month and week views and share the link. While one customer fills the form, a second customer cannot see or take that slot; after 5 minutes without booking it returns. The team page lists every active person with their next free time.

**Needs.** Feature 36 for service settings. Feature 1 for the hold expiry job (the engine copes without it).

---

### 40. Booking questions 2.0

**Size:** M

**Why it matters.** Booking forms today have text, email, phone, number, date, choices, yes/no and consent. Businesses need more: "If 'New patient', ask for the referral letter"; a hidden campaign field filled from the link; guests for a couple's massage; a phone-only booking for people without email; confirming the email is real before taking the slot. Each missing piece means a phone call.

**Use.** No new library. The condition editor uses coss `Select` and `Combobox`.

**Where.**

| Change | Path |
| --- | --- |
| Form schema | `src/lib/booking-forms.ts`: new field types `radio`, `checkbox_group`, `multi_select`, `url`, `address`, `emails` (guests), `name_split`; per field `show_when` (conditions), `hidden`, `prefill_key`, `lock_when_prefilled`; per service–form link `required_overrides` |
| Schema (migration `0030_booking_questions`) | `form_definition_services.required_overrides` (jsonb); `services.allow_guests`, `services.max_guests`, `services.contact_mode` (`email_or_phone`, `email_required`, `phone_only`), `services.verify_email`; new `email_checks` (tenant, email hash, code hash, expires at, attempts) |
| Server | `src/server/booking-forms.ts` (validation honours conditions), new `src/server/email-check.ts` |
| Routes | new `src/app/api/public/email-check/route.ts` (send and verify) |
| Screens | `src/features/clinic/booking-forms-settings.tsx` (new field types, a "Show this when…" row, hidden and locked switches), `src/features/booking/booking-form-question.tsx`, the details step in `src/features/booking/steps/*` |

**How.**

1. **New field types.** Radio (one of a few, shown as cards), checkbox group, multi-select (searchable, for long lists), URL, address (line 1, line 2, city, state, PIN code; stored encrypted like other answers), multiple emails (guests), and split first and last name.
2. **Conditions.** A field can be shown only when another field's answer equals, is not, contains or is one of given values. Only earlier fields can be referenced, so there are no loops; the editor enforces this. Hidden-by-condition fields are not required and their answers are dropped on save. Validation runs the same condition function on the server: a pure function in `src/lib/booking-forms.ts`, used by both sides.
3. **Prefill from the link.** Any field with a `prefill_key` reads `?key=value` from the booking URL, as do the built-ins `name`, `email`, `phone`, `notes`, `guests` and `location`. Values are validated against the field type and length; invalid ones are ignored silently. `lock_when_prefilled` shows the value read-only. A `hidden` field is never shown and is only filled from the link (for campaign tags); it is stored with the answers.
4. **Required per service.** The same form can be required on one service and optional on another, set where the form is attached to the service.
5. **Guests.** With `allow_guests`, the form shows "Add guests" for up to `max_guests` emails. Guests receive the confirmation and updates (through the outbox, by feature 2) and can't manage the booking. Guest emails are stored encrypted on the appointment and never logged.
6. **Contact mode.** `phone_only` hides email and requires a phone number; confirmations go by WhatsApp or SMS (features 3 and 4). `email_required` requires email.
7. **Email check.** With `verify_email` on, after the customer enters their email the page sends a 6-digit code (through the outbox) and the booking can't be submitted until it is entered. Codes are stored hashed, expire in 10 minutes, allow 5 attempts, and sends are rate-limited per email and per IP (feature 9). A customer already signed in to the portal skips it.
8. Old form versions keep working: answers are always read with the definition version they were written with.

**Done when.** A question "Have you visited before?" with "No" reveals "How did you hear about us?" and hides it again on "Yes"; a crafted request that sends an answer to the hidden question has it dropped. A link with `?email=…&campaign=diwali` fills the email (locked) and stores the hidden campaign answer. A couple's booking with one guest sends the confirmation to both. A phone-only service books without an email. With email check on, a wrong code three times then the right code books; a sixth attempt is refused.

**Needs.** Feature 2 for codes and guest emails, features 3 and 4 for phone-only confirmations, feature 9 for rate limits.

---

### 41. Approval rules

**Size:** M

**Why it matters.** Today a service is either instant or "request", for every booking. Businesses want finer rules: approve only last-minute bookings, or bookings from free email addresses that might be spam; decline with a reason the customer sees; let the customer offer a few times that suit them so staff can pick one. And they need to choose whether an unanswered request blocks the slot.

**Use.** No new library. The free-mail domain list is a small checked-in JSON file, `src/server/data/free-mail-domains.json`, kept short (the 50 largest providers).

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0031_approval_rules`) | `services.approval_rule` (`never`, `always`, `short_notice`, `free_mail`); `services.approval_notice_hours`; `services.requests_hold_slot`; `services.hide_location_until_confirmed`; `appointments.decline_reason_code`, `appointments.proposed_starts` (array of up to 10 times); keep `booking_mode` in step for old code until removed |
| Server | `src/server/appointment-state.ts` (requested → booked, requested → declined), new `src/server/approval.ts` |
| Routes | `src/app/api/staff/appointments/[id]/route.ts` gains actions `approve` (with an optional chosen proposed time) and `decline` (with a reason code and an optional message) |
| Worker | handler `request-expire` |
| Screens | "Approval" section in `service-editor.tsx`; an approval card in `appointment-task.tsx`; "Needs approval" tab in feature 43; the details step in `src/features/booking/steps/*` for proposing times; `manage-booking.tsx` shows "waiting for approval" |

**How.**

1. **Rules per service.** Never (instant), always, only when booked within N hours of the start, or only when the email is from a free-mail provider. `approval.ts` decides at commit time and returns `booked` or `requested`. Migrate `booking_mode = request` to `always`.
2. **Does a request hold the slot?** On: the slot is taken until approved or declined (current behaviour). Off: the slot stays open; approving checks the slot is still free inside the transaction and, if it is taken, asks staff to choose another time.
3. **Propose times.** With approval on, the customer can add up to 10 alternative times from the slot picker ("These also work for me"). Staff approve one of them in a single click; the appointment moves to it with the usual version check.
4. **Decline with a reason.** A short list (fully booked, outside our services, need more information, other) plus an optional message to the customer. The message goes in the outbox, not in audit metadata. The customer's manage link shows the outcome and a "Book another time" link.
5. **Expiry.** A request still unanswered at its start time is expired by the `request-expire` job and the customer told. Staff get a reminder at 50% of the time left (feature 56 when built; a staff inbox item before).
6. **Hide location.** With the switch on, the confirmation and manage page omit the address or call details until the booking is approved.
7. Every transition is in `appointment-state.ts`, with tests for each allowed and forbidden move.

**Done when.** A service set to "approve when booked within 24 hours" books instantly for next week and creates a request for tomorrow. A gmail.com address on a "free mail" service creates a request; a company address books. With "requests hold slot" off, a second customer can take the requested slot, and approving the first then asks staff to pick another time. A customer's proposed alternative can be approved in one click. A declined customer sees the reason and a link to rebook.

**Needs.** Feature 2 (or 3) for messages. Feature 43 for the approval tab (an approval card in the appointment works before it).

---

### 42. Cancel and reschedule policy

**Size:** M

**Why it matters.** Customers can cancel and reschedule from the manage link at any time, and the reason they type is thrown away. Businesses lose late-cancelled slots, can't see why people cancel, and can't stop a customer moving a visit an hour before it starts. Staff also need the reverse: "the doctor is unwell, please choose another time" without cancelling the booking and losing its history.

**Use.** No new library.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0032_cancel_policy`) | `services.allow_customer_cancel`, `services.allow_customer_reschedule`, `services.cancel_cutoff_minutes`, `services.reschedule_cutoff_minutes`, `services.reschedule_same_person`; `appointments.cancel_reason_code`, `appointments.cancel_reason_text` (encrypted), `appointments.cancelled_by` (`customer`, `staff`, `system`), `appointments.reschedule_reason_text` (encrypted), `appointments.reschedule_requested_at`, `appointments.rebooked_from_id`; a new `reschedule_requested` value in `appointment_status` (and `declined` and `expired` if feature 41 or 23 has not added them); new `cancel_note_presets` (tenant, label, sort order) |
| Server | `src/server/appointment-state.ts`, `src/server/appointment-repository.ts`, new `src/server/booking-policy.ts` |
| Routes | `src/app/api/public/appointments/*` (manage-token cancel and reschedule honour the policy and take a reason); `src/app/api/staff/appointments/[id]/route.ts` gains `request_reschedule`, `cancel` with a preset, `edit_guests` |
| Screens | "Cancelling and moving" section in `service-editor.tsx`; `src/features/booking/manage-booking.tsx`; `appointment-task.tsx` (Request reschedule in the ⋯ menu); presets in `settings-workspace.tsx` |

**How.**

1. **Per service switches:** customers may cancel (yes or no), may reschedule (yes or no), and each has a cut-off ("not within 12 hours of the start"). Inside the cut-off the manage page explains the rule and shows the business's phone number instead of the button. The server enforces the same rule; the page is only a hint.
2. **Reasons.** Cancelling asks for a reason from a short list (can't make it, booked by mistake, found another time, feeling better, other) and an optional note. Rescheduling has an optional note. Notes are encrypted, shown to staff on the appointment, and never written to audit metadata or logs.
3. **Staff ask the customer to reschedule.** One action frees the slot, keeps the same appointment in a new `reschedule_requested` state, and sends the customer a message with their manage link, which now opens straight on the slot picker. If the customer doesn't choose within the business's chosen time (default 7 days), it becomes a cancellation by the system and the customer is told.
4. **Keep the same person.** With `reschedule_same_person` on, the picker only offers the original person's slots; off, it offers anyone eligible (feature 20 when built).
5. **Staff can rebook a cancelled or past appointment** to a new time from its ⋯ menu; it creates a new appointment linked to the old one (`rebooked_from_id`) so history stays intact.
6. **Presets** for staff cancellations ("Doctor unwell", "Clinic closed") speed up the common cases and are a reason code, not free text.
7. **Guests.** From the manage link the customer can add or remove guests (feature 40), within the service's guest limit, until the cut-off.
8. **Fees.** Late-cancellation fees, refunds and no-show charges stay in feature 23; this feature only provides the cut-off times and reasons that feature 23's policy reads. Do not duplicate the policy table.
9. Each transition (cancel, reschedule, request reschedule, rebook) is in `appointment-state.ts` with tests, uses `expectedVersion`, writes an audit event and queues messages through the outbox.

**Done when.** With a 12-hour cut-off, the manage page hides "Cancel" 11 hours before the visit and a direct API call is refused. The reason a customer picks is shown on the appointment and in the cancellation report (feature 26). A staff "request reschedule" frees the slot, the customer gets a link, picks a new time, and the appointment keeps its id and history. A business that turns reschedule off sees no reschedule button anywhere on the customer side.

**Needs.** Feature 2 (or 3) for messages. Feature 23 reads the cut-off for fees. Feature 40 for guests.

---

### 43. Bookings list

**Size:** L

**Why it matters.** Staff find bookings through the day and week calendar. Questions like "which requests are waiting?", "who cancelled this month?", "all of Dr Rao's bookings next week, moved to Dr Shah" need a list. Feature 31 adds a basic list view with a few bulk actions; this is the full bookings screen that busy front desks live in.

**Use.** `@tanstack/react-table` (already installed). `nuqs` for filters in the address, added by feature 31; add it here if feature 31 has not landed.

**Where.**

| Change | Path |
| --- | --- |
| Schema (migration `0033_bookings_list`) | new `saved_views` (tenant, owner membership or shared, name, page `bookings`, filters jsonb, sort, columns); `appointments.customer_no_show_marked_at`, new `appointment_host_no_shows` (appointment, practitioner, marked by, at) |
| Server | new `src/server/bookings-list.ts` (one parameterised query builder over validated filters), new `src/server/bulk-actions.ts` |
| Routes | new `src/app/api/staff/bookings/route.ts` (GET list with cursor paging), `src/app/api/staff/bookings/bulk/route.ts` (POST), `src/app/api/staff/saved-views/route.ts`; `src/app/api/staff/appointments/[id]/route.ts` gains `reassign`, `edit_location`, `mark_no_show` |
| Activity | new `src/app/api/staff/appointments/[id]/history/route.ts` reading `audit_events` for that appointment |
| Screens | new `src/features/clinic/bookings-workspace.tsx` (nav item "Bookings"), new `booking-history.tsx` tab inside `appointment-task.tsx`; reuse `grid-filter.ts` and `grid-pager.tsx` |

**How.**

1. **Tabs:** Upcoming, Needs approval (feature 41), Repeating (feature 17), Past, Cancelled. Each shows its count. Default sort is by start time; Past and Cancelled sort newest first.
2. **Filters** in a single "Filter" dropdown (not a row of buttons): person, service, branch, status, booked via, date range, customer (search by name or phone), and UTM source or campaign. Filters live in the address so a link reproduces the view. **Saved views** store a filter set with a name, private or shared with the team.
3. **The query** is built by one function from a zod-validated filter object into a parameterised Drizzle query, under `withTenant`. Paging uses a cursor on `(starts_at, id)`, not offsets. Add indexes for the common filters and check the plan with `EXPLAIN` on 100,000 appointments.
4. **Columns:** time, customer, service, person, branch, status, booked via, source (referrer and UTM), price. The customer can choose and reorder columns; the choice is saved with the view.
5. **Bulk actions** on up to 100 selected bookings: confirm (for requests), cancel with a preset reason, mark no-show, reassign to a person, send a message. Each runs per booking inside its own transaction with its version check, so one failure does not undo the rest; the result lists what succeeded and what failed with reasons. Bulk endpoints are idempotent with an `Idempotency-Key` (`src/server/idempotent.ts`).
6. **Reassign** moves a booking to another person at the same time without cancelling it, after checking they are free and offer the service; both people and the customer are told. Same appointment, same manage link.
7. **Edit location** changes the location kind and detail (feature 36) and tells the customer.
8. **No-shows.** Mark the customer as a no-show (status `no_show`, as today) or the staff member as a no-show (the business didn't turn up), which records it and offers the customer a free rebook. Both appear in reports (feature 26).
9. **History tab** per booking: created, confirmed, moved (from → to), reassigned, form received, reminders sent, cancelled, with who and when, from `audit_events`. Show reasons as their labels; never show encrypted note text in the history.
10. **Staff override.** Booking from the list into a time the engine says is busy asks for confirmation and a reason code, and is recorded. The database overlap constraint still applies to true double-bookings of the same person; the override only skips soft rules (notice, window, limits).
11. Layout follows the standing preferences: one row of buttons that never wraps, extra actions in ⋯ (a bottom sheet on phones), the page fits the screen with the table scrolling inside it.

**Done when.** A receptionist opens Bookings, filters "Dr Rao, next week", saves it as a shared view, selects all 23 bookings and reassigns them to Dr Shah; 21 move, 2 report "Dr Shah is busy at 10:30" and stay. Each moved customer is told. Opening one booking's History shows the reassignment with who did it. The Needs approval tab lists every pending request across the business. Paging through 10,000 past bookings stays under 300 ms per page.

**Needs.** Feature 31 (this replaces its simple list view). Feature 41 for the approval tab, feature 17 for the repeating tab, feature 26 to report no-shows. Messages need feature 2 or 3.
