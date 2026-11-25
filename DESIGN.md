---
name: Kalendr
description: Appointments, organized with care.
colors:
  porcelain: "#FAFAFA"
  sidebar: "#ECEEF2"
  charcoal: "#23262F"
  secondary-ink: "#595F6D"
  cobalt: "#315CCE"
  cobalt-hover: "#264AAA"
  pale-blue: "#EAF0FF"
  hairline: "#DFE2E8"
typography:
  family: "Manrope, Segoe UI, system-ui, sans-serif"
  body: "1rem / 1.5"
  staff-title: "1.875rem / 1.2, 600"
rounded:
  sm: "8px"
  md: "12px"
---

# Design system: Kalendr

Kalendr is a calm scheduling workspace for a busy clinic. It favors legible lists, exact scheduling context, and one active task at a time. The landing page, sign-in, clinic setup, patient booking, and staff workspace share the approved porcelain, charcoal, and cobalt palette. Earlier green and crimson treatments are retired.

## Color and type

- Main surface: porcelain `#FAFAFA`; sidebar: soft gray `#ECEEF2`.
- Primary text: charcoal `#23262F`; secondary text: `#595F6D`. Borders: `#DFE2E8`; control outlines: `#8A919E`.
- Primary action and focus: cobalt `#315CCE`; hover: `#264AAA`. Selection: pale blue `#EAF0FF`.
- Shared color values live in `src/app/globals.css`; landing aliases refer to these values instead of maintaining a separate palette. Legacy `teal` component aliases follow the same action colors.
- Error and destructive action keep distinct, accessible semantic colors. Status always includes text.
- Manrope is self-hosted once through the root Next.js layout and serves headings, controls, and data. Operational titles use a fixed rem scale and modest tracking. Dates and times use tabular numerals.

## Staff shell

The desktop sidebar is about 224px wide with complete labels. The selected row uses a subtle pale-blue fill, stronger text, and a small trailing dot. There is no decorative left stripe. The mobile navigation is a five-item bottom bar; content remains readable above it. Header context identifies the clinic and marks the workspace as preview data.

## Page frame

Every sidebar destination is built from `WorkspacePage` and `WorkspaceFrame` (`src/components/workspace-page.tsx`), and no page sets its own outer width or padding.

- **Gutter:** the same on all four sides: 16px below 768px, 24px from 768px up. Pages are full width; nothing is centred in a narrower column.
- **Title row:** the page title on the left with no subtext under it, and the page's actions on the right (an action bar that folds into ⋯ when space runs out). An editor inside a page puts a back button before its title.
- **Frame:** the content sits in one frame card. Its toolbar has tabs (underline tabs) or a search on the left, and filters, view switches and secondary buttons on the right. A pager or save row goes in its footer. Tables and edge-to-edge lists use a flush panel.
- **Inside the frame:** sections are Cards (an `h2` CardTitle, content, an optional footer), not nested frames. A long list keeps its borders inside the frame, not a second border around it.
- **Height:** `fit="flow"` (default) grows with the page; `fit="screen"` fills the window so a calendar, inbox or long table scrolls inside its frame.
- Screens reached from a page but not listed in the sidebar (profile, import, appointment task, new appointment, privacy requests, notifications, series view) still use the older `PageHeader` and are not yet on this frame.

## Browse, then focus

- **Today:** a patient flow board groups same-day visits as Arriving, Checked in, and In appointment, with a Completed view. Search and practitioner or room filters narrow the board. Needs action ranks booking requests, missing forms, and waits of at least 15 minutes; owners and brief scheduling handover notes remain visible through the browser session. Team now describes the current schedule and any visit marked in progress. On mobile, Patient flow and Needs action have separate tabs. Staff can advance the preview clock in 15-minute steps to inspect waits and schedule context.
- **Desktop Today layout:** the shell header, Today title and filters, and compact Team now row stay within the viewport. Each patient-flow column and the Needs action panel has its own named, keyboard-focusable vertical scroll area. Tablet and phone layouts retain normal page scrolling where the viewport is too narrow for the full board.
- **Add appointment:** staff search existing patients by name, stable patient ID, phone, or email, with an optional field filter. Results show contact details and recorded visit context; the selected patient and ID stay visible through review. New patient entry suggests reuse when a phone or email exactly matches an existing record. Staff then choose an eligible service and opening on a selected clinic date. A compatible opening chosen from Schedule carries its date, location, practitioner, room, and service into this focused task. The route shows a review before confirmation, keeps the draft when moving back, and adds the patient and appointment to the preview session only after confirmation. Returning to Schedule restores the selected date, view, and location.
- **Schedule:** Day is the team calendar, Week is a single-practitioner planning calendar, and List includes requested, booked, cancelled, and no-show history. Date, search, location, practitioner, room, and status controls work across dates, including empty dates. Calendar events and before/after buffers follow clinic time; saved blocks appear without silently moving appointments. Selecting an open time reveals compatible service/room choices, a booking path, and matching waitlist offer review. Opening an appointment enters a focused task route for approval, rescheduling, cancellation, no-show, or visit actions.
- **Week planning:** staff review working-hour and time-off changes against affected bookings before saving. Existing bookings remain and appear as needing reschedule review. A recurring series previews every weekly occurrence and can be confirmed only when all dates are compatible. Waitlist offers are local previews and do not send or reserve.
- **Desktop Schedule layout:** the shell, title and controls, and legend stay within the viewport. The calendar, List, and planning/context panel scroll independently with named keyboard-focusable regions; time and practitioner/day headers remain visible while scrolling. Narrow screens use a readable List and normal page scrolling.
- **Patients:** directory and search first; no automatic profile selection. Search includes the same patient ID, name, phone, and email fields used by appointment booking. IDs are visible in directory rows and profiles. Selecting a patient opens a profile with Overview, Appointments, and Contact details. Back returns to the current directory search.
- **Appointment task:** show patient, service, time, practitioner, resource, readiness, contact preference, and activity. Scheduling uses Choose time → Review change → Confirmation. Picking a slot is draft state only. Approval, check-in, start, completion, and form receipt use a short review. Start checks for overlapping visits before marking a visit in progress. Cancellation and decline name their consequence before confirmation.
- **Follow-ups:** Waitlist and Recalls remain separate. A selected entry opens a focused task with preferences, compatible openings or a message preview, review, and explicit action.
- **Settings:** four section hub: Services, Availability, Reminders, Website connection. Each editing flow has review and a preview save result. Back from review preserves the draft. Website connection offers hosted link, inline iframe, popup widget, and developer API paths, with separate exact website and Kalendr origins, copyable installation code, local booking tests, and multiple named preview setups. Saving records the plan in this browser session; website installation and deployment origin approval remain separate.

## Patient time selection

Patients choose an available date before scanning its appointment times. The date selector includes opening counts and preserves every date returned by availability. Returning from Details restores the selected date and time; browsing a different date keeps the existing selection explicit with a way back to it. Loading failures offer a retry without discarding visit choices. Confirmation distinguishes a saved booking, a request awaiting review, and an unsaved offline demonstration; it does not imply notification delivery.

## Customer pages and reviews

These pages use the business's own words (`useTerms()`), the same porcelain, charcoal and cobalt palette, and coss components. They work from 320px wide with no sideways scrolling. The full plan and its dated decisions are in [the discovery and reviews plan](docs/DISCOVERY_AND_REVIEWS_PLAN.md).

- **Person card (shared):** one shape wherever a person is listed (team section, guide results, portal). Top row: small rounded pills (rating, starting price, visit count) and a three-dot menu for everything secondary (See profile, Book another day, Share). Then the name and role on the left with the photo on the right, one short grey line, a single row of two-line day chips (weekday over date, the soonest filled, the row scrolls rather than wraps), and at most two equal-width buttons. A tap anywhere that isn't a button opens the profile. Cards sit one per row on phones, two from 640px and three on wide portal screens.
- **Business page `/b/[slug]`:** the link an owner shares ("Your page"). A header card holds the cover (none: no banner), logo or initials, name, rating line, first address with a map link, today's hours, Book now and Call. Below it: one search box that filters services and team in the browser, category chips (only when some service has a category), service cards that open booking with that service, and team cards (the shared person card) with a row of "next free" days. Each day opens booking with that person and date. Reviews show the latest three with See all; About shows the business description and hours per location. When the owner has switched on "Help me choose", a card under the header shows the guide's title and introduction and opens it. `/book/[slug]` stays the booking flow for website buttons and embeds.
- **Person profile `/b/[slug]/team/[id]`:** a top row with a round Back button, the business name and a three-dot menu (Share profile, Call, See everything); then rating and starting-price pills, name and role with the photo on the right, a stats panel that shows only known facts (years, reviews, services) and only when there are two or more, and full-width underline tabs About, Reviews and Availability. A long bio is cut to four lines with See more. "Book with {first name}" sticks to the bottom on phones and sits in the header from 768px. With no time picked it opens the Availability tab and moves focus there. Picking a time opens a "Confirm booking?" drawer with a close button and four short rows (With, service with length and price, When with the time zone, location), then "Continue booking" above "Pick another time"; the Book button then reads "Book {day}, {time}" and reopens the drawer. Continue opens booking with service, person, date and time.
- **Help me choose `/b/[slug]/find`:** the owner's questions, one per screen, as whole-card choices (radio cards for one answer, checkbox cards for several) with a progress bar, Back, and Continue, which reads "Skip this question" until something is picked. Four or more short answers with no description sit two to a row. A three-dot menu in the header holds Skip to results, Start again and See everything. Then "Here's what we'll look for": each question with its answer and a pencil button to change it, and one button that says how many fit ("See 3 doctors"). Results list each person who fits as the shared person card: rating and price pills, "{n} free times · next 7 days", and up to six day chips that open booking with that person and day. Two icon buttons in the header replace the old chip row: Sort (Soonest free, Top rated, Lowest price) and Your answers (tap one to change it, Start again, See everything); the services that fit follow. Answers live in the link (`?step=` and `?answers=`), so Back, Forward and sharing work. No match shows an empty state with Change answers and a link to everything.
- **Booking preselects:** `?service=`, `?person=`, `?date=` and `?time=` on `/book/[slug]`. A linked time that is still free is chosen and the flow moves on to the details. A person who doesn't offer the chosen service, a day with no free times, or a time that has gone is ignored without an error.
- **Confirmation and manage page:** Add to calendar is a menu (Google Calendar, Apple Calendar, Outlook, Outlook.com). Booked visits get a QR card, "Show this when you arrive", with a short reference to read out; it shows until the visit ends and never in preview or the portal. The confirmation asks "How did you hear about us?" once as one-tap cards with Skip; staff see the answer on the appointment and as "How people found you" in the Today header.
- **Check-in `/check-in/[token]`:** the QR's target. Staff of the same business land on the appointment and press Check in themselves; anyone else lands on the manage page.
- **Reviews:** a customer reviews a finished visit from the manage link only, within 60 days of its end: 1 to 5 stars (five large tap targets labelled "1 star" to "5 stars") and an optional comment up to 1,000 characters, editable in the same window. They are asked 2 hours after staff mark the visit finished. The shown name is first name and last initial. Reviews publish straight away. The average appears only from 3 shown reviews; below that, only the count ("1 review"). Healthcare and dental businesses show "Please don't include health details." under the comment; others show "Keep it about your experience."
- **Portal → {Providers} tab:** everyone the signed-in customer has booked with, most recent first, as the shared person card: visit-count and next-visit pills, name, role, "Last on {date}", and two equal buttons, "Book again" (opens booking with that person and the last service) and Share (the phone's share menu, or copies the link with a toast). The three-dot menu holds See profile and See {business}. Someone who has left shows a "Not taking bookings" pill and no buttons. With nobody yet, an empty state points to each business's page.
- **Settings → Help me choose:** owners and admins write up to 8 questions with 2 to 12 answers each, choose one or several answers, and tick the services each answer fits; an answer with nothing ticked fits everything. A new business starts from questions written from its own services and categories. A switch hides the guide without losing it, and "Try it" previews the result count without saving.
- **Settings → Reviews:** every review, newest first, with stars, comment, service, person and date, a person filter, and a "Shown on your page" switch. A hidden review carries a Hidden badge, is dimmed, and never leaves the server on public pages. Owners set About in Settings → Customer page and a Category on each service there.

## Interaction contract

A proposed slot must match service duration, eligible practitioner, location, resource kind, working hours, blocked time, waitlist preferences where applicable, and existing appointment occupancy including buffers. Patient and practitioner conflicts apply across clinic locations; resource conflicts use shared resource IDs. Only explicit confirmation updates the appointment. Preview state persists in browser session storage across staff routes. It is not a production save; no patient notification is sent from these controls. In appointment is a preview visit stage recorded alongside the existing checked-in status until completion. Team now is schedule context, not a live presence signal. No example domain or illustrative queue record should appear as a ready integration or executable task.

Every visible control has keyboard focus, a readable state label, and a minimum comfortable target. Transition headings receive focus after an in-page stage change. Long schedules scroll inside their own calendar region; the page itself does not acquire horizontal overflow.

## Public landing page

The public site has six pages in `src/app/(marketing)/`:

- Home (`/`)
- Online booking
- Front desk
- Businesses (`/industries`)
- Clinics
- Privacy and security (`/trust`)

They share one header and footer, which read their page list from `src/features/marketing/site-nav.ts`. They also share parts from `page-parts.tsx`. The look matches the app: Inter, porcelain, charcoal and the app's tokens. Like every public page, the site is always light.

Each page leads with a two-line headline and a short Stageshow demo. The demo is filmed through the kit's rehearsal gate at full width and at 390px, and has a reduced-motion poster. The demos use fictional businesses and the app's real words. Each page claims only what [STATUS.md](docs/STATUS.md) lists as Done.

The full contract is in [the landing design guide](docs/design/landing-DESIGN.md).

## Clinic onboarding

Registration has four live stages: Clinic, Location, Account, and Review. The
first stage combines clinic name, owner name, practice type, and whether the
owner also sees patients. Preview omits Account and has three stages: Clinic,
Location, and Review. A named progress rail appears on desktop; phones show a
compact current-stage label and progress count. Back, review edits, and completed
rail steps preserve the current in-memory draft. Reload persistence is not
implied.

City and street address are entered explicitly; state selection never
substitutes a preset city. The booking slug is suggested from the clinic name
and can be edited. Account fields use persistent labels, autocomplete, an
explicit password hint and show-password control. Shared fields associate errors
with controls, native form submission supports Enter, and transition headings
receive programmatic focus without an interactive outline. Long booking paths
and contact values wrap within the review panel. Creation occurs only from
Review; saving disables the form and exposes a busy state. A saved clinic whose
owner cannot yet sign in has a recovery route to verification and sign-in.

After account creation, setup is derived from saved clinic configuration. Visit
duration, approval rules, dedicated space, practitioner identity, and working
hours are reviewed explicitly. Hours start from a weekday, Monday-to-Saturday,
or weekday-evening preset, then expose seven open-day checkboxes and editable
start/end times in the clinic timezone. At least one open day and an end after
the start are required. Practitioner creation can save identity and hours
together; existing practitioners can reach a separate missing-hours task.
Completion provides patient-page review, link copying, policy/website settings,
and Today. Missing configuration remains visible in the staff workspace so
owners can return later. Development rehearsals are labelled preview and do not
create accounts or save their custom choices as live clinic configuration; the
sample booking page uses its own demonstration services and hours.

The database-backed Website connection settings provide a tenant-specific
installation guide for a booking link, inline frame, or popup button. The guide
uses the current deployment origin and actual clinic slug, wraps long addresses,
contains code scrolling within its panel, and reports copy results. Embedded
code requires an exact website origin; generating instructions does not save or
approve it. The deployment operator must approve frame origins, and popup sites
must allow the widget script. The richer browser-session website preview remains
a separate settings experience and does not imply tenant installation.
