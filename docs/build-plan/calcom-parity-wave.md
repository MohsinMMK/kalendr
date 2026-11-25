# Cal.com parity wave (25 Nov 2026)

The owner compared Kalendr with Cal.com (signed in, free plan) and asked for the features worth copying plus a cleaner staff UI. Kalendr serves every kind of business (clinics, salons, real estate, consulting, tutoring), so every label, example and default in this wave is industry-neutral and goes through `useTerms()`.

**Trunk:** `master`. Builders branch from it, merge its latest before finishing, and never merge into it themselves. The coordinator merges lane A first, then B, then C.

**Rules:** follow the builder rules in [WAVES.md](WAVES.md#rules-for-every-builder-session) and the standards in [STANDARDS.md](STANDARDS.md).
- Never migrate `.local-db`. Use a scratch PostgreSQL through `scripts/e2e-database.mjs`.
- Use the official coss compositions, and Drawer, never Sheet. Check APIs against the installed package docs (coss and Kloq `llms.txt`, `node_modules/next/dist/docs/`, `node_modules/ai/docs`).
- Keep the Kloq calendar files untouched.

## What was checked first

The first comparison overstated the gaps. A code check on 25 Nov found most of the ten features already built:

| Cal.com feature | In Kalendr | This wave |
| --- | --- | --- |
| Optimized slots (start times line up with existing bookings) | Missing | Lane B builds it |
| Availability troubleshooter | Built: the "Why no slot" drawer (`why-no-slot-sheet.tsx`, `slot-engine/explain.ts`) | Lane A links it from the service editor |
| Live booking preview while editing a service | Missing | Lane A builds it |
| Out of office that sends bookers to a colleague | Built: time off with a public note and a cover person; the booking page shows the cover's times | Lane C gives it a clearer screen |
| Customer proposes several times | Built for services that need approval (up to 10 times, approved in one click) | Dropped |
| Require a cancellation reason | Built: customers must pick a reason | Dropped |
| Book again from an old reschedule link | Partial: a moved booking's old link stops working on purpose (`appointment-repository.ts:668`) | Lane B adds a friendly landing |
| One-time email code so no one books with someone else's email | Built: the service's "Verify email" setting | Dropped |
| Digest email | Partial: the staff morning digest exists | Lane C adds a weekly or monthly summary for owners |
| Dynamic group link | Built: combined links book two to four people at the same time | Dropped |

Of the UI ideas, these already exist and are dropped: business-type presets for real estate, professional services and education; a calendar view of bookings (Schedule); templates on Campaigns.

## Who owns which shared file

Only the owner of a file restructures it. Everyone else adds one-line hooks at most and says so in their report.

| File | Owner |
| --- | --- |
| `src/features/clinic/service-editor*.tsx`, `service-editor.test.tsx`, `patient-page-settings.tsx`, `src/server/services-admin.ts`, `src/lib/page-access.ts`, the new Services route | A |
| `src/server/slot-engine/*`, `src/features/booking/booking-flow.tsx`, `src/features/booking/steps/*`, `manage-booking.tsx`, `manage-policy.tsx`, `src/server/appointment-repository.ts` | B |
| `src/features/clinic/clinic-frame.tsx`, `assistant/copilot-panel.tsx`, `time-off-panel.tsx`, `availability-extras.tsx`, routing-form screens, `src/worker/jobs.ts`, `src/app/api/staff/me/notifications/route.ts` | C |
| `src/db/schema.ts` | Add-only: B and C each add their columns, nothing else |

- B and C put their new service settings in their own files (for example `service-optimized-slots-field.tsx`). After A merges, each adds one line to place it in A's editor.
- A's Services entry in the sidebar is a one-line hook in `clinic-frame.tsx`, which C owns.

## Migrations

| Lane | Number | Journal `when` |
| --- | --- | --- |
| A | none (list order lives in `tenants.layout`) | none |
| B | `0082_…` | `1797800000000` |
| C | `0083_…` | `1797900000000` |

## Lane A: Services page and full-page service editor

**What you build:**
- **A Services page in the sidebar** (route and `page-access.ts` entry, using the business's own word for services):
  - Rows show name, length, price and a "Hidden" badge.
  - An on/off switch on each row.
  - Preview, copy link and a ⋯ menu with Duplicate and Delete. Duplicate already has a route (`/api/staff/services/[id]/duplicate`).
  - Search, and drag to reorder (reuse the order saved in the workspace layout that `patient-page-settings.tsx` uses today).
  - An empty state with a "New service" action.
- **The service editor becomes a full page** instead of the drawer behind Settings → Client page → Edit → More settings.
  - The 14 tabs in `serviceEditorTabs` move into a left nav with four groups:
    - Setup: basics, lengths, where, hours.
    - Booking experience: look, page, questions.
    - Policies: timing, limits, approval, cancelling, payment.
    - Automation: routing, calendar.
  - A link at the bottom opens the existing "Why no slot" drawer for this service.
  - Header: back, name, on/off, preview, copy link, embed, delete, Save.
  - A search box that filters settings by title and jumps to the match.
  - Keep the tab ids so deep links keep working; update `service-editor.test.tsx`.
- **Live booking preview** on the right at 1024px and wider (a "Preview" button opens it in a Drawer below that). It renders the real booking card from unsaved form values and updates as you type.
- **One pattern for every setting:** title, one help line, and a switch that reveals its fields. Apply it to every editor section.
- **Business default vs this service:** where a setting has a business-wide default (hours, cancel cutoffs, approval), show "Uses business default" with a Customize action, and a Reset that goes back to the default.
- **Settings → Client page** keeps the business-wide settings and links to the Services page.

**Done when:**
- A salon, a real estate office and a consulting business each see their own word for services on the page and in the editor.
- A service can be duplicated, hidden, reordered, searched and switched off from the list.
- Changing the name, length or price shows in the preview before saving.
- Searching "cancel" jumps to the cancellation setting.
- Resetting a customized setting restores the business default.
- The old drawer links open the new page on the same tab.
- Every editor section works at 375px.

## Lane B: booking engine and booking card

**What you build:**
- **Optimized slots** (migration 0082: `services.optimized_slots boolean not null default false`).
  - When on, start times are offered next to existing bookings first, so the day has fewer gaps. Times on the normal interval still show after them.
  - It lives in `slot-engine/offerable-slots.ts` and respects buffers, limits, holds, holidays and time off.
  - The setting goes in its own field file.
- **Friendly landing for an old reschedule link.**
  - The old link stays dead for managing the booking. Never make an old token valid again.
  - When it is opened, show "This booking was moved" with the new time if the same customer still has it.
  - Otherwise show a "Book again" button that opens the service's booking page.
  - A per-service switch (in 0082, `services.rebook_from_old_link`, default on) turns the "Book again" button off.
- **A more compact booking card:**
  - Day, week and column view switches as icons in the card's corner.
  - A small green dot on each open time.
  - The time zone shown under the booking details, not as a separate block.
  - Keep `column-view.tsx` and every existing view working.

**Done when:**
- With optimized slots on and a booking at 10:00–10:45 on a 30-minute interval, 10:45 is offered first.
- With the setting off, the times are unchanged; unit tests cover both cases.
- An old reschedule link shows the new time, or "Book again", and can never cancel or move the booking.
- The booking card passes at 375px and 1440px, and keyboard users can switch views.

## Lane C: staff shell, time off and owner summary

**What you build:**
- **The public booking link pinned at the bottom of the sidebar**, with Copy and Open. It is hidden for roles without access to the booking page.
- **Starter prompts in the copilot** when the chat is empty. Four suggestions, worded for any business, for example "Who is booked tomorrow?", "Find a free hour on Friday", "Which customers haven't come back in 60 days?" and "Draft a reminder message".
- **Templates for an empty Routing forms page:** three neutral starters ("Which service do you need?", "New or returning customer", "Pick a location"). Each creates a draft form.
- **A clearer time-off screen** with two tabs, using the existing `time_off` and holidays APIs:
  - My time off: dates, reason, public note, cover person.
  - Holidays: the business's closed days.
  - Show what a booker will see (the note, and whose times appear) next to each entry.
- **A weekly or monthly summary email for owners** (migration 0083 adds the choice to the staff notification settings: off, weekly or monthly).
  - It shows bookings, cancellations, no-shows, new customers and revenue for the period, with the change from the last period.
  - It is a worker job beside `staff_digest`, goes through the outbox, and is set in the existing notification settings.

**Done when:**
- The sidebar link copies the right URL for the business.
- A new chat shows the four prompts, and clicking one sends it.
- A routing form template creates a draft that can be edited and published.
- Adding time off with a cover person shows the cover note on the time-off screen and on the booking page.
- A weekly summary for the test business renders with real numbers in capture mode.
- Opting out stops it.

## After the builders

Two Opus reviewers check engine, security and money (lane B, migrations, worker job), then screens (lanes A and C). Then the coordinator's browser pass, then the owner's hand test.
