# Kalendr booking experience plan

Written 11 November 2026. Branch: `kalendr-generalization`.

**Goal.** A customer should be able to book in under a minute on a phone, guided by pictures and one clear question per screen, typing only four things. The business owner does the harder work once: adding pictures and setting things up. Customer side first, owner side second.

**How to use this document.** Work through the phases in order. Each phase has tasks and a "Done when" list. Tick the Progress checklist at the bottom as you go, and add anything you had to decide under "Decisions made while building". Stop and report at the two review points marked **REVIEW STOP**.

---

## 1. What the audit found

Read this first so you do not "fix" things that are already right.

**The coss primitives are official.** All 55 files in `src/components/ui/` exist in the coss registry. 53 are identical apart from import paths. Two have small deliberate changes (`sidebar.tsx` fixed skeleton width for a lint rule; `slider.tsx` adds `getAriaValueText`). The colour tokens, radius scale and keyframes in `src/app/globals.css` match the official coss style. Do not reinstall or restyle primitives.

**What is actually hand-made** (this is the replacement list):

| # | Hand-made thing | Where | Replace with |
|---|---|---|---|
| 1 | Radio card faked with a button (`aria-pressed`, circle icons) | `ChoiceOption` in `src/features/clinic/onboarding-choice.tsx:304-341` (used in `setup-workspace.tsx` ×5, `start-clinic-form.tsx` ×1); `OpeningButton` in `task-ui.tsx:64-80`; `new-appointment-task.tsx:332` | coss `RadioGroup` + `Radio` inside a `Label` (particles `p-radio-group-4`, `p-radio-group-6`, `p-radio-group-10`) |
| 2 | Numbered-dot steppers | `BookingSteps` `booking-flow.tsx:306-355`; `TaskSteps` `task-ui.tsx:19-51`; setup rail `onboarding-choice.tsx:116-140` | coss has no stepper. Use one coss `Progress` bar plus a text label ("Step 2 of 4"). See section 5. |
| 3 | Bordered boxes built from raw `<dl>`/`<section>`/`<div>` with `rounded-xl border` | `booking-flow.tsx:952, 1577, 1599, 1640`; `manage-booking.tsx:579`; `start-clinic-form.tsx:489`; `setup-workspace.tsx:429, 783` | coss `Card` / `Frame` |
| 4 | Legacy `Sheet` (coss replaced it with `Drawer`) | `portal-workspace.tsx`, `schedule-workspace.tsx`, `records-workspace.tsx`, `dashboard-workspace.tsx`, `schedule-sheets.tsx`, `doctors-workspace.tsx` | coss `Drawer` with `position="right"` (Phase E) |
| 5 | Raw HTML where a primitive exists | `<button>` `records-workspace.tsx:242`; `<label>` `team-workspace.tsx:476`; `<fieldset>` in `onboarding-choice.tsx:268`, `profile-workspace.tsx:160`, `team-workspace.tsx:464`, `doctors-workspace.tsx:74` | `Button variant="link"`, `Label`, `Fieldset`/`FieldsetLegend` |
| 6 | Card checkboxes that differ from the particle | `setup-workspace.tsx:227`, `start-clinic-form.tsx:320` | particle `p-checkbox-4` classes |
| 7 | Hand-written labels/errors outside `Field` | `date-picker.tsx:107-110`, `slot-picker.tsx:189`, `hours-editor.tsx:86` | `FieldLabel`, `FieldError` |

Already following official particles, keep as the base: `slot-picker.tsx` (`p-calendar-19`), `date-picker.tsx` (`p-date-picker-6`), `radio-card.tsx` (`p-radio-group-4`).

**Pictures today.** The only picture in the product is the staff photo (`practitioners.photo_data_url`, a 256px JPEG stored as a data URL, resized in the browser by `src/lib/image-resize.ts`). Services have no picture. The business has no logo or cover. The booking header shows initials. `public/onboarding/*.webp` (six landmark images) are not rendered anywhere.

**Motion today.** No motion library. `tw-animate-css` is installed (official coss dependency) and used once in app code (`onboarding-choice.tsx:248`). Everything else is the primitives' own transitions.

**The customer flow today** (seen live at phone and desktop width): five text-only screens. (1) new or returning, (2) location and service as text cards, (3) provider then calendar with times below the fold, (4) a ten-control form (first name, last name, mobile, email, reason, contact preference, reminders, accessibility, privacy notice, consent), (5) a review screen. Every choice needs a second tap on Continue.

---

## 2. Design principles and where they come from

Each rule below is tied to a source. Items marked *(direction, not sourced)* are well-known patterns that could not be confirmed from an open page; treat them as design direction rather than a spec to copy.

1. **One question per screen.** One decision per page is easier on phones, makes errors easier to recover from, and lets progress save between steps. [GOV.UK form structure](https://www.gov.uk/service-manual/design/form-structure)
2. **Cut fields before cutting steps.** Field count hurts completion far more than step count; the average checkout asks 11.3 fields where about 8 are needed. [Baymard](https://baymard.com/blog/checkout-flow-average-form-fields)
3. **Never ask for an account to book.** 18% abandon when a site demands an account. [Baymard](https://baymard.com/lists/cart-abandonment-rate) Kalendr already books without an account; keep it that way.
4. **Ask who they are last.** Duolingo moved sign-up later and gained about 20% daily users; let people choose first, identify last. [First Round](https://review.firstround.com/the-tenets-of-a-b-testing-from-duolingos-master-growth-hacker/)
5. **Say how short it is.** Duolingo opens with "Just 7 quick questions". [Screensdesign](https://screensdesign.com/articles/duolingo-onboarding-design/) We show a progress bar and "Step 2 of 4".
6. **Tappable cards, not dropdowns.** Dropdowns are "the UI of last resort". [LukeW](https://www.lukew.com/ff/entry.asp?1950) Options are whole-card targets with a clear selected state (Duolingo's language list, Airbnb's property-type tiles *(direction, not sourced)*).
7. **Wizard basics.** Show the steps and the current one, explicit Back and Next, keep answers when going back. [NN/g wizards](https://www.nngroup.com/articles/wizards/)
8. **Touch targets at least 44–48px.** [NN/g](https://www.nngroup.com/articles/touch-target-size/) The project already forces 44px on touch devices in `globals.css`.
9. **Pictures sell the choice.** Square shows a photo per service and per staff member; Fresha shows portfolio photos beside services with a "Book now" button; Booksy recommends at least three photos. [Square](https://squareup.com/help/us/en/article/8425-promote-your-brand-and-services-on-your-booking-site), [Fresha](https://www.fresha.com/blog/fresha-service-portfolio-feature), [Booksy](https://booksy.com/biz/en-us/blog/taking-photos-that-attract-new-customers)
10. **Date and time layout from Cal.com.** Details on the left, calendar in the middle, times on the right once a date is picked; one stacked column on phones. Default booking fields are just name and email, notes optional. Confirmation offers "Add to calendar". (Read from the Cal.com source: `packages/features/bookings/Booker/config.ts`, `getBookingFields.ts`, `bookings-single-view.tsx`.)
11. **Owner setup in chapters.** Airbnb's host flow has three named chapters: tell us about your place, make it stand out (photos, title), finish and publish. [Airbnb guide](https://www.airbnb.com/resources/hosting-homes/a/how-to-get-started-on-airbnb-3) A fixed bottom bar with Back and Next under a three-part progress bar, and +/- counters for numbers *(direction, not sourced)*.

### Reference screens to look at

Open these before building the matching screen. Do not copy artwork, mascots, wording or brand colours; take the structure only.

- Duolingo onboarding, 8 screens, no login: https://screensdesign.com/explore/apps/duolingo/onboarding/
- Duolingo onboarding walkthrough, 10 screens: https://screensdesign.com/articles/duolingo-onboarding-design/
- Airbnb guest booking and listing screens: https://www.banani.co/references/apps/airbnb
- Airbnb Setup (host onboarding) screenshots: https://news.airbnb.com/2022-winter-release/
- Cal.com Booker documentation: https://cal.com/docs/platform/atoms/booker
- Partly gated (first few screens free): https://experiments.lazyweb.com/flow/duolingo/onboarding , https://design.lazyweb.com/canvas/flows/airbnb/onboarding
- Page Flows (may need a trial): https://pageflows.com/web/flows/listing-a-property/ , https://pageflows.com/web/flows/booking-a-room/
- Mobbin needs a paid plan for flows; nothing free was found for Fresha or Booksy screens. Their help pages above describe the flows in words.

---

## 3. Decisions

1. **Pictures live in the database, served by a public image address.** A new `media_assets` table holds the image bytes per business. Not data URLs inside the catalog (ten service photos would add over a megabyte to every page load), and not the disk file store (that is for private record files and is never public).
2. **Three kinds of picture for now:** business logo (square), business cover (16:9), one photo per service (4:3). Staff photos stay exactly as they are.
3. **Pictures are resized in the browser before upload** by extending `src/lib/image-resize.ts`. No new dependency, no server image library.
4. **A missing picture is a first-class state.** A service without a photo shows a tinted tile with an icon. If no service has a photo, the list uses compact rows without tiles, so a new business never shows a wall of identical placeholders.
5. **The booking request sent to the server does not change.** `src/lib/contracts.ts` public booking schema stays as is. Only the screens change. The four required things to type are first name, last name, mobile, email (the database requires phone and email).
6. **Consent behaviour does not change.** The privacy notice stays an explicit tick and the reminders opt-in keeps its current default. Only their layout gets lighter. (See open question 2.)
7. **No separate review screen.** The summary is always visible (side column on desktop, a one-line bar that opens a drawer on phone and tablet), and the final button sits on the details screen.
8. **Tap to choose and move on.** Tapping or clicking a card selects it and advances after a short beat. A Continue button stays for keyboard and screen-reader users. Arrow-key movement inside a radio group must never advance.
9. **Motion uses what coss already uses:** CSS transitions and `tw-animate-css` utilities, 200ms, always behind `motion-safe:`. No motion library.
10. **Staff workspace clean-up (Sheet to Drawer and similar) comes last**, after both customer and owner flows.

---

## 4. Guardrails

- **Next.js:** this is Next.js 16 with breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (route handlers, images, navigation).
- **coss:** use the `coss` and `coss-particles` skills in `.claude/skills/`. Check primitives and particles before writing custom markup. For a particle, read its registry JSON (`https://coss.com/ui/r/<particle-name>.json`) and follow its markup and classes inside our own component; do not add particle demo files to the repo. Do not edit files in `src/components/ui/` except to install an official update.
- **Do not touch `src/components/kloq/`.**
- **Database:** never edit existing files in `drizzle/`. Change `src/db/schema.ts`, run `pnpm db:generate`, then add row-level security to the generated migration by hand, matching `drizzle/0010_booking_forms.sql` (`ENABLE` and `FORCE ROW LEVEL SECURITY` plus a `"tenant_isolation"` policy on `tenant_id`). Do not rename existing tables, columns or files.
- **No new dependencies** unless something cannot be done without one; if so, stop and say why.
- **Secrets:** never print values from `.env*` files or `.local-db/*.env`.
- **Git:** do not commit, push, merge or switch branches. Leave changes in the working tree. Four files already have uncommitted changes from earlier work and are not yours to revert or reformat: `.claude/launch.json`, `docs/KALENDR_PLAN.md`, `scripts/local-db.sh`, `scripts/seed-local-db.mjs`. You may add a launch configuration to `.claude/launch.json` without changing the existing ones.
- **Dev servers:** never start or stop anything on port 3000 (the owner's own server). Use the `kalendr-preview-3001` launch configuration for preview mode. For real uploads against the local database, add a launch configuration modelled on `next-dev-local-db` that runs on port 3002 with its own `KALENDR_NEXT_DIST_DIR`.
- **Words:** use the business's own words through `useTerms()` and `useFeatures()`. Never hardcode "patient", "doctor" or "clinic". Copy is plain, short, and sentence case.
- **Gate for every phase:** `pnpm lint && pnpm typecheck && pnpm test` all pass, and the screens are checked in the browser at 375×812, 768×1024 and 1280×800 with no sideways scrolling (also check 320px wide).
- **Keep working:** embed mode and the `?service=` preselect on `/book/[clinicSlug]`, the three confirmation states (saved, request awaiting review, unsaved demo), focus moving to the step heading after a step change, the error summary, and reduced-motion support.

---

## 5. Building blocks

### coss pieces to use

| Need | Use |
|---|---|
| Picture choice card (service, business type) | `RadioGroup` with the `p-radio-group-6` pattern (visually hidden `Radio`, ring on the card when checked); grid variant `p-radio-group-10` |
| Text choice card | existing `src/features/booking/radio-card.tsx` (`p-radio-group-4`) |
| Person tile | `Avatar` (`p-avatar-17`, `p-avatar-5`), existing `PersonAvatar` |
| Calendar and times | existing `SlotPicker` (`p-calendar-19`); disabled dates as in `p-calendar-7` |
| Progress | `Progress` (`p-progress-2`/`p-progress-3`) |
| Phone and tablet summary, profile details, "more dates" | `Drawer`; responsive dialog/drawer pattern `p-drawer-12`; scrolling body with pinned footer `p-drawer-6` |
| Optional extras on the details screen | `Collapsible` |
| Two-way choice inside a screen | `SegmentedControl` or `ToggleGroup` (`p-toggle-group-8`) |
| Multi-select cards | `p-checkbox-4` |
| Numbers with +/- (duration, price) | `NumberField` (`p-number-field-1`, `-7`, `-9`) |
| Opening hours rows | `p-switch-7/8/9` as reference for `hours-editor.tsx` |
| Loading | `Skeleton` (`p-skeleton-1/2`), `Spinner` |
| Empty state | `Empty` (`p-empty-1`) |
| Messages | `toastManager` (`p-toast-2`, `p-toast-5`), `Alert` (`p-alert-3/5/7`), `FieldError` |
| Horizontal scrolling row | `ScrollArea` (`p-scroll-area-2`, `-4`) |
| Boxes | `Card`, `Frame` |

**coss does not provide** a stepper, file upload/dropzone, image cropper, carousel or phone input. These are the only places a small composition of our own is acceptable:

- **Progress header:** one `Progress` bar, with a visible "Step 2 of 4" and the screen title. No numbered dots.
- **Image upload control** (`src/components/image-upload.tsx`): a `Button` that opens a visually hidden file input (as `doctors-workspace.tsx` already does), a preview in the right aspect ratio inside a `Card`/`Frame`, Replace and Remove buttons, `Spinner` while uploading, `FieldError` for problems, and drag-and-drop on desktop as an extra. Label and help text through `Field`.
- **Service picture card** and **person tile:** compositions of `RadioGroup`, `Avatar`, `Badge` and the image.

### Motion rules

Match the primitives: 200ms, `ease-in-out`, opacity plus a small move, always `motion-safe:`; with reduced motion, fade only or nothing.

- **Step change:** the incoming screen fades in and slides 12px from the right going forward, from the left going back. Use `tw-animate-css` utilities (`motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-3 motion-safe:duration-200`, and `slide-in-from-left-3` for back), keyed on the step so it replays. `onboarding-choice.tsx:248` is the existing precedent.
- **Selected card:** ring and background change with `transition-[box-shadow,background-color] duration-200`. On hover-capable devices the picture scales to 1.03 (`motion-safe:group-hover:scale-[1.03] transition-transform duration-300`), clipped by the card.
- **Tap-advance beat:** about 180ms between selection and the step change so the selected state is seen.
- **Times appearing:** `Skeleton` while loading, then the list fades in.
- **Confirmation:** the success mark pops once using the existing `animate-toast-success-*` keyframe style in `globals.css` (scale pop, 0.32s). No confetti.
- **Progress bar:** `Progress` already animates its width.
- **Drawer, dialog, collapsible, toast:** use as shipped.

---

## 6. Phases

### Phase A — Pictures: storage, upload, settings

**A1. Table.** Add `media_assets` to `src/db/schema.ts`:

- `id` text primary key (`gen_random_uuid()::text`), `tenant_id` text not null → `tenants.id` on delete cascade
- `kind` varchar: `business_logo`, `business_cover`, `service`
- `owner_id` text not null: the service id for `service`; the tenant id for the two business kinds
- `content_type` varchar (`image/jpeg` or `image/webp`), `width`, `height`, `byte_size` integers
- `data` bytea (use drizzle's bytea type if the installed version has one, otherwise a `customType`; check the installed `drizzle-orm`)
- `created_at`
- unique on (`tenant_id`, `kind`, `owner_id`)

Generate the migration, then add the row-level security statements by hand. Replacing a picture deletes the old row and inserts a new one, so every picture address is permanent and can be cached forever. When a service is deleted, delete its picture row in the same operation (check whether services are deleted or only switched off).

**A2. Staff upload.** `POST /api/staff/media` (multipart: `file`, `kind`, `ownerId`) and `DELETE /api/staff/media/[id]`, permission `settings.manage`, modelled on `src/app/api/staff/records/[id]/files/route.ts` and `src/app/api/staff/services/route.ts`. Server checks, in `src/server/media.ts`:

- reject by `content-length` before reading; hard limit 600 KB after reading
- accept only JPEG and WebP, decided by the file's first bytes (JPEG `FF D8 FF`; WebP `RIFF....WEBP`), never by the name or declared type
- for `service`, the service must belong to the business (query inside `withTenant`)
- record the change wherever service edits are recorded today, if they are

**A3. Public image address.** `GET /api/public/media/[clinicSlug]/[id]`: resolve the business from the slug with `kalendr_resolve_tenant` exactly as `src/server/public-catalog.ts:109` does, read the row inside `withTenant`, return the bytes with the stored `Content-Type`, `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`. Anything else is a 404. Follow whatever rate limiting the other `/api/public/*` routes use. The content security policy already allows same-origin images (`img-src 'self' data: blob:` in `src/lib/security-headers.ts`); do not widen it.

**A4. Catalog.** Add `imageUrl?: string | null` to `Service` and `logoUrl?`, `coverUrl?` to `Clinic` in `src/lib/domain.ts`. Fill them in `getPublicClinicCatalog` with one extra query on `media_assets` (ids only, never bytes). The staff snapshot gets the same fields so settings can show current pictures. Preview mode has no database: these fields are simply absent there (see open question 1).

**A5. Browser resize.** In `src/lib/image-resize.ts` add a function that centre-crops to a target aspect ratio and returns a JPEG `Blob` (quality about 0.82): service 960×720, cover 1600×900, logo 256×256. Keep `photoToDataUrl` for staff photos. Reuse `photoProblem` for the "not an image / too large" messages.

**A6. Upload control and settings.** Build `src/components/image-upload.tsx` (section 5). Use it in:

- Settings → Business profile (`business-profile-settings.tsx`): logo and cover
- Settings → Customer page (`patient-page-settings.tsx`), where services are edited: one photo per service, visible in the service list as a thumbnail

In preview mode the control shows the picture for the current visit only and says plainly that preview does not save pictures.

**Done when**
- [x] An owner can add, replace and remove a logo, a cover and a photo for each service, on phone and desktop.
  - 2026-11-11: add, replace, remove and cross-business isolation verified over HTTP against the local database (`/api/staff/media`, `/api/public/media`). Not yet clicked through in Settings in the browser: signing in there would expose the local test owner's details. Open for the reviewer.
- [x] The public address returns the image with long-lived caching, and a second business cannot read it through its own slug (test).
- [x] A non-image, a renamed file and an oversized file are each refused with a plain message (tests).
- [x] Lint, typecheck and tests pass.

### Phase B — Customer booking flow

Split `src/features/booking/booking-flow.tsx` (1,841 lines) into a small coordinator plus one file per screen under `src/features/booking/steps/`, with shared pieces (`booking-progress.tsx`, `booking-summary.tsx`, `service-card.tsx`, `person-tile.tsx`, `booking-bottom-bar.tsx`). Put the step logic in a pure function with unit tests.

**B1. Steps.** Only the steps that need an answer are shown:

| Step | Shown when | Title (use the business's words) | Content |
|---|---|---|---|
| Visit type | Removed: the customer is never asked (the server gets "new" when the service accepts it, else the service's first type) | n/a | n/a |
| Location | more than one active location | "Which location suits you?" | Text cards with address. Tap advances. |
| Service | no valid `?service=` preselect | "What would you like to book?" | Picture cards. Tap advances. |
| Provider | more than one eligible person for the service and location | "Who would you like to see?" | "Anyone available" first, then person tiles with photo, name, speciality. Tap advances. Otherwise the booking uses `first_available` or the single person silently. |
| Time | always | "When works for you?" | Calendar and times. Tap a time to advance. |
| Questions | the service has a booking form | the form's name | The business's own questions (`BookingFormQuestion`). |
| Details | always | "Last step: your details" | Four fields and the Book button. |

The progress bar counts only the shown steps. "Booking for myself / someone else" (`features.dependents`) moves from the first screen to the top of Details as a two-way segmented choice; first confirm nothing earlier depends on it (see `booking-flow.tsx:498`), and if something does, keep it as a second tile row on the first shown step.

**B2. Screen frame.**

```
Phone (375)                         Desktop (1280)
┌───────────────────────────┐      ┌──────────────────────────────────────────────┐
│ logo  Business name       │      │ logo  Business name                          │
│ ▓▓▓▓▓▓▓░░░░░░  Step 2 of 4│      │ ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░   Step 2 of 4    │
│ Cut · Tue 12, 10:30    ⌄  │      ├──────────────────────────────┬───────────────┤
├───────────────────────────┤      │ What would you like to book? │ Your booking  │
│ What would you like to    │      │ ┌──────┐ ┌──────┐ ┌──────┐   │ [photo]       │
│ book?                     │      │ │photo │ │photo │ │photo │   │ Service       │
│ ┌───────────────────────┐ │      │ │name  │ │name  │ │name  │   │ With          │
│ │ photo │ Name          │ │      │ │45m ₹ │ │30m ₹ │ │60m ₹ │   │ When          │
│ │       │ 45 min · ₹800 │ │      │ └──────┘ └──────┘ └──────┘   │ Where         │
│ └───────────────────────┘ │      │                              │ Price         │
│ ┌───────────────────────┐ │      │ [Back]            [Continue] │               │
│ │ photo │ Name          │ │      └──────────────────────────────┴───────────────┘
├───────────────────────────┤
│ Back            Continue  │  ← fixed bar, respects the phone's safe area
└───────────────────────────┘
```

- **Header:** logo (or initials), business name, one `Progress` bar and "Step n of m". On the first screen only, the cover picture shows above the title (16:9 on phone capped at about 180px tall; a wide banner on desktop). No cover: no banner, no placeholder.
- **Summary:** from 1024px a sticky right column (`Card`, about 340px) with the service photo, service, person, date and time, location, price, each with a "Change" link once chosen. Below 1024px a one-line summary under the progress bar that opens a bottom `Drawer` with the same content. Empty lines are not shown before their step.
- **Bottom bar:** Back (ghost) on the left, Continue (primary) on the right. Fixed to the bottom below 768px with safe-area padding; in the page flow from 768px. Back is hidden on the first shown step.
- **Browser Back** goes to the previous step instead of leaving the booking. Use history entries per step (check the Next.js 16 navigation docs for `window.history.pushState` support). Reloading may restart the flow; that is acceptable.

**B3. Service cards.** `RadioGroup` in the `p-radio-group-6` pattern.

- Phone: one column of horizontal cards, picture 88px square on the left (rounded), then name (medium weight), "45 min · ₹800", and one line of description clamped. Approval-mode services show a small `Badge` "Request".
- 768px and up: grid, two columns at tablet and three at desktop inside the content column, picture on top at 4:3, text below.
- No picture for this service: tinted tile (`bg-accent`, icon in `text-muted-foreground`). No pictures at all: compact text rows without tiles.
- Images: explicit width and height or aspect ratio so nothing jumps; lazy-load below the fold. If `next/image` is used, pass `unoptimized` (pictures are already sized); read the Next.js image docs first.
- The whole card is the target. Selected state: `ring-2 ring-primary/48` and `bg-accent/50`.

**B4. Person tiles.** "Anyone available" first (group icon, "Earliest time with any {provider}"). Then one tile per person: `Avatar` at 56–64px with the photo or initials, name, speciality. Two columns on phone, three or four from tablet. Keep the existing bio/qualifications content reachable through a "About {name}" link that opens a `Drawer` (phone) or `Dialog` (desktop), as in `p-drawer-12`.

**B5. Time.** Keep `SlotPicker`'s logic and its `p-calendar-19` base.

- On arrival, preselect the earliest date with openings so times show without a tap.
- From 768px: calendar on the left, times on the right, as Cal.com does. On phone: calendar, then times directly beneath; after picking a date, scroll the times into view (smooth only with motion allowed).
- Group times under small headings Morning, Afternoon, Evening; hide empty groups. Times are toggle buttons at least 44px tall in a two- or three-column grid.
- Dates without openings are disabled. Loading shows `Skeleton`; failure keeps the existing retry without losing earlier choices.
- State the timezone once in muted text if the current flow does.
- Replace the hand-written error `<p>` at `slot-picker.tsx:189` with `FieldError`.

**B6. Details.** A summary of the choice sits at the top on phone (it is already in the side column on desktop).

- Four fields: first name and last name side by side, mobile, email. Set `autocomplete` (`given-name`, `family-name`, `tel`, `email`), `inputMode`, `type` and `enterKeyHint` so the phone offers saved details and the right keyboard.
- `features.dateOfBirth` on: date of birth appears, using the existing date picker.
- One `Collapsible` "Add a note or request (optional)" holding the reason/note, accessibility needs and contact preference. Closed by default. Contact preference keeps its current default.
- Reminders opt-in: one compact row, same default as today.
- Privacy notice: explicit tick as today, with the notice text collapsed behind a "Read the privacy notice" link.
- Button: "Confirm booking", or "Send request" for approval-mode services. Errors keep the existing summary and field messages; a field error inside the closed collapsible opens it.

**B7. Motion and focus.** Apply the motion rules in section 5. After each step change, focus the step heading (existing `[data-step-heading]` behaviour). Tap-advance must come from pointer or touch only: check `event.detail > 0` on click, or use pointer events, so arrow keys and screen-reader activation do not advance.

**B8. Tests.** Update `booking-flow.test.tsx` for the new screens. Add unit tests for the step function (every combination of the conditions in B1) and confirm the request body sent to `/api/public/appointments` is unchanged.

**Done when**
- [x] A single-location business with one service list books in three or four taps plus four typed fields.
- [x] Every screen has one title, at most one helper line, and no sideways scrolling at 320, 375, 768 and 1280px.
- [x] Pictures show on service cards, in the header and in the summary; the no-picture states look intentional.
- [x] Keyboard only: every screen can be completed, arrow keys never skip a screen, focus lands on the heading.
- [x] Reduced motion: no slides or scaling.
- [x] Embed mode (`/embed-demo`) and `?service=` still work.
- [x] `BookingSteps`, the numbered "what happens next" circles and the raw bordered boxes in the booking flow are gone (audit items 2 and 3).
- [x] Lint, typecheck and tests pass.

### Phase C — Confirmation and manage booking

- **Confirmation:** success mark with the single pop, "You're booked" / "Request sent" / the existing demo wording, a `Card` with the service photo and booking details, "Add to calendar" (existing `/api/public/appointments/[token]/calendar`), the manage link, and "What happens next" as a short plain list. All three existing states keep their meaning.
- **Manage booking** (`src/features/booking/manage-booking.tsx`): same header, same summary `Card` with the photo, same time picker layout, same bottom bar. Replace the raw bordered `<dl>` at line 579.

**Done when**
- [x] Booking, rescheduling and cancelling look like one product at all three sizes.
- [x] Lint, typecheck and tests pass.

**REVIEW STOP 1.** Stop here and report: what changed, what was verified in the browser at each size, anything not done. Do not start Phase D until told to.

### Phase D — Owner sign-up and setup

Same frame as the customer flow (progress, one question per screen, bottom bar with Back and Next), organised as three chapters in the Airbnb manner. Keep every existing rule in DESIGN.md "Clinic onboarding": creation happens only from Review, passwords stay in memory, preview creates nothing, readiness is derived from saved configuration.

**Chapter 1 — Your business** (`/start`, `start-clinic-form.tsx`, `onboarding-choice.tsx`)
1. "What kind of business do you run?" Eight picture tiles (large lucide icon, label, one-line example), two columns on phone, four on desktop, `RadioGroup` grid (`p-radio-group-10`). Tap advances. Replaces the text radio rows and `ChoiceOption`.
2. "What's it called?" Business name and the owner's name; the "I also see {customers}" choice as a `Switch` row.
3. "Where are you?" Existing place picker and address.
4. Account (live only), then Review and create, unchanged in behaviour.

**Chapter 2 — What you offer** (`/setup`, `setup-workspace.tsx`)
5. A short opener: "Three quick things and your booking page is live", listing the three.
6. First service: name, then duration and price with `NumberField` +/- controls, with a live service card beside it (below it on phone) built from the same `ServiceCard` the customer sees.
7. "Add a photo of this {service}" with the upload control; "Skip for now" is always offered.
8. Who provides it: the person's name and photo (reuse the existing staff photo upload), or "Just me".
9. "Make it yours": logo and cover, skippable.

**Chapter 3 — When you're open**
10. Hours, using the existing presets and `hours-editor.tsx`.
11. "You're live": the booking link with copy, "Open my booking page", and a preview card of the page as customers see it.

Replace `ChoiceOption`, the setup rail stepper, the card checkboxes and raw boxes listed in section 1 (items 1, 2, 3, 6) within these files.

**Done when**
- [x] A new owner reaches a live booking page with a service photo without visiting Settings.
- [x] Every photo step can be skipped, and skipped photos can be added later in Settings.
- [x] Works at all three sizes; lint, typecheck and tests pass (update `start-clinic-form.test.tsx`, `setup-workspace.test.tsx`).

**REVIEW STOP 2.** Stop and report as before.

### Phase E — Staff workspace clean-up

- `Sheet` → `Drawer position="right"` in the six files in section 1, item 4. Read `.claude/skills/coss/references/primitives/drawer.md` first; behaviour (focus, close, scrolling body, pinned footer) must be unchanged or better.
- `OpeningButton` and the button-radio at `new-appointment-task.tsx:332` → `RadioGroup` cards. `TaskSteps` → the same progress header as the booking flow.
- Raw `<button>`, `<label>`, `<fieldset>` → coss primitives (item 5). Hand-written labels/errors → `Field` parts (item 7).
- Leave `platform-demo.tsx`, the landing page and anything under `kloq/` alone.

**Done when**
- [ ] `grep -rn "components/ui/sheet" src/features` returns nothing.
- [ ] Existing tests pass without weakening them.

### Phase F — Write it down

- Update `DESIGN.md`: the new customer flow, pictures, the motion rules, the owner chapters. Remove statements that are no longer true (for example the four-stage registration description if it changed).
- Update `PRODUCT.md` only where it describes the booking flow.
- Final pass at 320, 375, 768 and 1280px, in light and dark if dark is reachable, with keyboard and with reduced motion.

---

## 7. Progress

- [x] A1 table and migration with row-level security
- [x] A2 staff upload and delete
- [x] A3 public image address
- [x] A4 catalog fields
- [x] A5 browser resize
- [x] A6 upload control and settings
- [x] B1 step logic with tests
- [x] B2 screen frame, summary, bottom bar, browser Back
- [x] B3 service cards
- [x] B4 person tiles
- [x] B5 time
- [x] B6 details
- [x] B7 motion and focus
- [x] B8 tests
- [x] C confirmation and manage booking
- [x] **Review stop 1**
- [x] D chapter 1
- [x] D chapter 2
- [x] D chapter 3
- [ ] **Review stop 2**
- [ ] E staff clean-up
- [ ] F documents and final pass

### Decisions made while building

(Add dated notes here.)

- **2026-11-11 · Change time is a screen, not a dialog.** On the manage page, "Change time" opens an inline screen with the same time picker and bottom bar as booking, and Back returns to the booking. A dialog on a phone hid the calendar behind the keyboard and broke the "one product" goal.
- **2026-11-11 · Manage page shows the business.** The manage header carries the business logo and name like the booking header, so a customer coming back from a link knows where they are.
- **2026-11-11 · "Reschedule" became "Change time".** Plainer words; the button and screen title match.
- **2026-11-11 · One detail row.** `BookingDetailRow` is exported from `booking-confirmation.tsx` and used by the manage page too, replacing the raw bordered `<dl>`.
- **2026-11-11 · Hidden tile radios sit in an `sr-only` span.** The coss `Radio` adds its own sizing classes, so `sr-only` on the radio itself left a visible box at some widths. Wrapping it keeps the tile as the only visible control without touching `src/components/ui/`.
- **2026-11-11 · The booking shell clips sideways overflow.** Step slide-ins briefly widened the page at 320px; `overflow-x-clip` on the shell root stops that without breaking sticky positioning (unlike `overflow-hidden`).
- **2026-11-11 · Cross-business picture isolation is tested against the local database.** `src/server/media.integration.test.ts` runs when a local database is available; the unit tests cover the same rules with a fake store.
- **2026-11-11 · Picture addresses keep their own cache header.** `next.config.ts` set `no-store` on every `/api/*` path, which overrode the long cache the media route sets. The rule now skips `/api/public/media/`; every other `/api` route and the media 404 still send `no-store` (checked over HTTP).
- **2026-11-11 · Setup choices use the `p-radio-group-6` card grid.** The plan named `p-radio-group-10`, which is not in the coss particle index; the card grid gives the same whole-card choice with the radio hidden.
- **2026-11-11 · The person is saved with the hours.** The setup API needs working hours to create a calendar profile, so the "Who provides it?" answer is held and sent with the hours step.
- **2026-11-11 · Hours use `HoursEditor`.** Presets, day toggles and one time range replace the old checkboxes and time inputs in setup. `DESIGN.md` "Clinic onboarding" is brought up to date in Phase F.
- **2026-11-11 · The person photo reuses the staff photo pattern** (square crop, initials when empty) instead of a second upload style.
- **2026-11-11 · "Make it yours" shows once per visit.** After Next or Skip it does not come back until the owner reloads; the pictures stay editable in Settings, under Business profile.
- **2026-11-11 · Step motion sits on an inner wrapper.** A transformed parent would pin the fixed bottom bar inside it, so only the step content slides.
- **2026-11-11 · Setup counts steps in the order they appear.** The service photo comes straight after the service is saved, so it is counted before the room or chair step, and that step stays counted once a saved service needs one, so the total holds steady after a reload.
- **2026-11-11 · Live setup frame.** A signed-in owner sees no "Staff sign in" button, and the footer says each step saves as you go.
- **2026-11-11 · Embed header and details.** On phones the embed header's Call button is icon-only and the name truncates; date of birth sits in the optional details collapsible.
- **2026-11-11 · Browser sign-in on port 3002.** `.local-db/runtime.env` trusts only the port 3000 origin, so a separate launch configuration (`kalendr-local-db-3002-browser-sign-in`) adds `http://localhost:3002` to the trusted origins for that server only. The existing configurations are unchanged.

---

## 8. Open questions for the owner

None of these block the work; each has a default.

1. **Sample pictures for the demo.** Preview mode has no database, so the demo business shows the no-picture layout. Bundling sample photos needs a decision on where they come from and their licence. Default: no bundled photos; pictures are tested against the local database.
   - *Decided 2026-11-11:* the owner said yes. The demo business uses six illustrations drawn in-house, kept in `public/demo/dental/` (logo, cover and four service pictures); nothing was downloaded. Dental and healthcare previews show them; every other preview business type shows no pictures (text rows and initials).
2. **Privacy tick.** The tick could be folded into an "Agree and book" button to save a tap. That changes how consent is recorded, which matters for healthcare businesses. Default: keep the explicit tick.
3. **Email.** Making email optional would cut the form to three fields, but the database and confirmations need it today. Default: keep it required.
4. **More than one photo per service** (a small gallery, as Fresha does). Default: one photo now; the table allows more later.

---

## 9. What the reviewer will check

- The booking request body and the consent defaults are unchanged.
- A second business cannot read another's pictures; uploads refuse non-images.
- No new dependencies; no edits to existing migrations, `src/components/ui/` or `kloq/`.
- Each screen at 375, 768 and 1280px: one question, picture-led where pictures exist, nothing cut off, bottom bar reachable, tap targets at least 44px.
- Keyboard, screen-reader labels, focus after step change, reduced motion.
- The hand-made items in section 1 are gone from the files each phase touched.
