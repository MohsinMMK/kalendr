# Browser pass, 21 November 2026

The coordinator's pass over every built feature's "Done when", in a real browser, on trunk `kalendr-generalization`.

## How it was run

- **Build:** production build (`pnpm build`) served with `next start` on `localhost:3100`. The settings match `playwright.config.ts`.
- **Services:** the outbox worker ran in `local_capture` mode. Email, WhatsApp and SMS went to the e2e capture server.
- **Database:** the e2e database `kalendr_e2e` on its own Postgres. The owner's database on port 5544 was never touched.
- **Screens:** desktop at 1073px and 800px wide, plus spot checks at 375px and in dark mode.

## Results

| Area | Result | Notes |
| --- | --- | --- |
| Public booking (`/b/…`, `/book/…`) | Pass | First visit, service, doctor or "anyone available", time, details, consent, confirmation with QR code. The time hold counts down. |
| Manage link | Pass | View, move and cancel from the link. Cancelling uses the confirm dialog. |
| Messages | Pass | Confirmation email and WhatsApp arrived at the capture server. |
| Today and patient queue | Pass | Board, list and timeline views. Call next. |
| Schedule | Pass | Drag to move, Undo, staff and day views. |
| Bookings | Pass | Table, filters, export. |
| Command palette | Pass | ⌘K finds patients, pages and actions. |
| Patients | Pass | Profile, History, Notes, segments, filters. |
| Patient merge | Pass | Possible duplicates (same phone). Choose which profile to keep. The toast gives the undo-until date. Undo merge on the kept profile works. |
| Classes and waiting list | Pass | Add class, add session, book a seat, waiting list. |
| Offers | Pass | Packages, memberships, codes. Selling a package shows its credits on the patient. |
| Billing | Pass | Invoices, payment record, day end. |
| Reports | Pass | Every tab, CSV export. |
| Campaigns | Pass | Recall audience, test send to the capture server. |
| Routing forms | Pass | Build, preview, publish, answer, report, wrong assignments. |
| Settings | Pass | All 27 sections open and save. |
| Developers | Pass | API keys (step-up sign-in first), scopes. Webhooks refuse private and loopback addresses. |
| Notifications | Pass | Bell, needs-attention list, alert settings. |
| Patient portal | Pass | Email code sign-in. Upcoming, Past, Packages, privacy. |
| Find us (`/explore`) | Pass | Empty until "Let patients find us on Google" is on. Then the clinic is listed, with type and city filters. |
| Embed demo | Pass | The overlay frame opens and books. |
| AI assistant | Pass | After "Chat on your booking page" is on, "Ask us" opens the chat and the test model answers. |
| Walk-in queue | Pass | Door QR code → join form → token page ("You're next", alert switch). |
| Phone width (375px) | Pass | Booking page, booking flow, portal, Today: no sideways scroll. |
| Dark mode | Pass | Today, Schedule, Patients. Public pages stay light by design. |

**Not tested by hand.** These are covered by Playwright specs that pass:

- Smart waitlist offers (`smart-waitlist.spec.ts`).
- Online payment at `/pay/test` (`online-payment.spec.ts`).
- Ratings at `/r/…` (`ratings.spec.ts`).

**Hindi:** there is nothing to test. Languages (feature 33) was dropped. Only the privacy notice and the assistant have Hindi.

## Defects fixed in this pass

Each fix was checked again in the browser after a rebuild.

| | Defect | Fix |
| --- | --- | --- |
| D1 | An "anyone available" booking's confirmation said "Anyone available" instead of the doctor who was given the visit. | The booking result now carries `practitionerId`, and the confirmation names that doctor. Checked: it showed Dr Kavya Rao, and the database agrees. |
| D4 | A stray vertical scrollbar beside the underline tab rows (patient profile, bookings, reports, offers, billing, organisation). | `overflow-y-hidden` on those tab rows. |
| D6 | Package and offer dates in another year had no year, so a year-long package read "Valid until 21 November" (today). | `offerDay` adds the year when it is not this year, on staff screens and in the portal. Two unit tests. |
| D8 | After a new routing form was published, its header still said "New routing form · Not saved yet". | Publish now saves, publishes, and then opens the saved form. Checked: "Live · Version 1" right away. |
| D11 | The portal header showed the long "Alerts are blocked…" sentence, squeezing the name to "Pa…" on a phone. | The alert switch has a compact mode for the portal header, which hides itself when alerts can't be used. |
| D12 | The assistant's message box did not have focus when the chat opened or after a reply, so typed text went nowhere. | The box takes focus when the chat opens, and gets it back after each reply. |

## Minor items fixed afterwards

Fixed the same day, then checked again in the browser on a fresh build. `pnpm check` passes.

| | Defect | Fix |
| --- | --- | --- |
| D2 | "New session" with no classes yet was a dead end. | It now says there are no classes yet and has an "Add a class" button that opens New class. Unit test. |
| D3 | After "Class added", the session form did not start on the new class. | The new class is chosen, with its teacher, place and seats filled in. It waits for the refreshed class list, since the cached one doesn't have the class yet. Unit test. Checked in the browser. |
| D5 | Selling a package was under Edit details. | The patient profile has a Packages tab of its own. Checked in the browser. |
| D7 | The recall message said "your last Check-up". | The message names the service: the campaign's service, or the patient's last finished visit among the recall's services, or the first of them. Checked: the preview read "your last Dental cleaning". |
| D9 | Email was required, with the browser's own bubble. | Email is optional; the server takes a blank one. Missing fields show messages under each field. Email is still needed when the preferred contact is email. Checked in the browser. |
| D10 | An existing phone number gave no warning when adding a patient. | The form warns at the top and the button becomes "Add anyway". The server also refuses a likely duplicate (same phone or email) with `409 possible_duplicate` and the matching names until staff choose Add anyway. Checked both in the browser. |

## Open, minor (not fixed)

- **Merge:**
  - The merge toast has no Undo button; undo is only on the kept profile.
  - The duplicate card counts only finished visits ("0 visits" while a booking exists).
- **Embed demo:** it hard-codes the `indiranagar-dental` page. On a database without it, it shows "This booking page is unavailable".
- **Settings:**
  - `?section=` in the address doesn't open that section.
  - `settings-workspace.tsx` line 52 lists `"brand" | "domain"` twice in a type.
- **Class-cancelled page:** a large gap above the card.
- **Segments:** "No visit in 90 days" leaves out people who have never visited.
- **Narrow screens:**
  - At 800px, the bookings table and the reports tab row scroll sideways.
  - On a phone, the booking footer's "Ask us" button covers part of the footer line.
- **Messages:** SMS is the default reminder channel. For India, WhatsApp is arguably the better default.
- **Routing forms:**
  - A class is offered as a routing destination.
  - The address ending fills from the form name, then keeps what is typed after it, which can double it ("pass-check-formpass-check").
- **API keys:** a key shows "Last used: Never" right after it was used.
- **Alerts:** class bookings read as a plain "New booking".
- **Booking flow:** step 2's "Choose a service" error showed once on arrival, before any choice. It did not happen again in two more tries; most likely a double click from the test tool.

## Test data left in `kalendr_e2e`

- **Settings turned on:**
  - Clinic listing turned on.
  - Booking-page assistant chat turned on.
- **Created:**
  - A door QR code.
  - Walk-in token 1 (Kabir).
  - The routing form "Pass check form" (published).
  - A booking for Dev Anyone, Saturday 21 November at 16:30, with Dr Kavya Rao.
- **Patients:** Meera Pass and Meera P were merged and then unmerged. Dup Check was added (phone 90000 11122) to test the duplicate warning.
- **Classes:** Fix check yoga, Fix check stretch and Fix check final, each with no sessions.
