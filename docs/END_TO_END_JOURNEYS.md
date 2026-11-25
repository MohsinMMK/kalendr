# Kalendr end-to-end journeys

> Kalendr now serves any appointment-led business. This audit was written for clinics and uses healthcare words (patient, doctor, visit, clinic); other business types see their own words on screen, and records apply only where the records feature is on (healthcare and dental by default). Rows in section 1 and section 5 were updated after the generalization; the rest is the 10–11 November audit.

Status: audit of 10 November 2026, traced from code and the running local database app.
Each step is marked **Works** (saved in the clinic database), **Preview** (browser-only demo state) or **Missing**.
The build plan at the end orders the gaps so each phase leaves a complete, usable journey.

## The whole system on one page

```
OWNER ──register /start──▶ CLINIC SET UP /setup ──▶ TEAM gets access ──▶ ROLES decide what each person sees
                                                                  │
PATIENT ─┬─ website (hosted page / iframe / widget) ──┐           ▼
         ├─ phone call (staff books) ─────────────────┼──▶ APPOINTMENT ──▶ arrive ▶ check in ▶ with doctor ▶ complete
         └─ walk-in (arrives with no booking) ────────┘                                                    │
                                                                                                           ▼
                                     MESSAGES (WhatsApp / SMS / email) ◀── RECORDS (report, prescription) ◀┘
                                                     │                                 │
                                                     ▼                                 ▼
                                       follow-up · recall · waitlist        patient portal (one-time code)
                                                     │
                                                     ▼
                                     BUSINESS: settings · reports · audit
```

## 1. Owner onboarding

| Step | State | Where |
| --- | --- | --- |
| Register a business: business type and name, place, owner sign-in, review | Works (business type checked in preview only) | `/start`, `src/server/clinic-registration.ts` |
| "I also see {customers} at this {business}" makes the owner a provider too (owner role + linked practitioner profile) | Works | `start-clinic-form.tsx`, `staff-team.ts` |
| Guided setup: service → resource → provider → assignment → hours, using the type's words and starter services | Works | `/setup`, `setup-workspace.tsx` |
| "Your booking link is live": `/book/[slug]` with copy and share, website options as optional next steps | Preview (not yet walked on the database app) | `setup-workspace.tsx` |
| Change business type, rename words, switch features | Preview (not yet walked on the database app) | Settings → Business profile |
| Build booking forms and attach them to services | Preview (migration `0010_booking_forms` not yet applied to a database) | Settings → Booking forms |
| Email verification and abuse controls before a live host | Missing | registration is closed in production unless enabled |

## 2. Owner gives doctors and staff access

Updated 11 November 2026 after phase 1 (walked through on the database app).

| Step | State | Notes |
| --- | --- | --- |
| Add a doctor (login + bookable profile + services + hours) | Works | Practitioners → Add practitioner |
| Invite staff by email: admin, receptionist, billing or read-only | Works | Settings → Team and access → Invite staff |
| How the new person gets in | Works | One-time link to choose their own password (`/reset-password`). Without an email provider the owner sees the link to copy |
| Resend invite / send password reset | Works | Row menu. A new link revokes every earlier one |
| Forgot password | Works | `/forgot-password`. Same answer whether or not the email exists |
| Link tokens | Works | Stored as SHA-256 hashes (`verification.storeIdentifier: "hashed"`), never in plain text |
| Change someone's role | Works | Edit access. The role preset applies again, and overrides that no longer differ are dropped |
| Deactivate / reactivate a member | Works | Deactivating deletes all their sessions at once |
| Remove a member | Missing | Deactivate only, so history stays attached to a person |

## 3. Roles and fine-grained control

Each person gets a **role preset** plus **per-person overrides**, resolved on every request (`src/lib/permissions.ts`).

| Role | Starts with |
| --- | --- |
| Owner | Everything, no overrides possible |
| Admin | Everything, but can't change the owner or grant what they don't have |
| Receptionist | Book and change visits, move visits along, own profile |
| Practitioner | Move visits along, own patients' records, own profile |
| Billing | Own profile; sees the schedule and patients, changes nothing |
| Read-only | Own profile; sees the schedule, changes nothing |

- Switches in Edit access turn single permissions on or off: booking, status changes, records, record access log, own profile, own hours, everyone's hours, clinic settings, team, activity log.
- Every staff API route checks the permission **before reading the request body**. A refused person gets a 403, and the attempt is written to the audit log with the permission and role.
- Settings → Activity shows who changed what in plain language ("Role: Receptionist → Billing", "Taken away: …", "Signed out on every device") and every refused attempt. It can be filtered by Team, Settings, Visits, Records and Refused.

## 4. Profiles

| Who | State |
| --- | --- |
| Doctor: specialty, qualifications, registration number, experience, languages, photo, bio, phone, services, hours | Works (owner/admin edit it) |
| Owner who is also a doctor | Works (owner role + linked profile; sees the whole clinic) |
| "My profile" for every signed-in person | Works: name, password change (other devices are signed out) and a read-only list of their access |
| Doctors edit their own public profile and working hours | Works when the person has "Edit own profile" / "Change own working hours" |

## 5. Patient arrives through the website

Updated 11 November 2026 after phase 2 (walked through on the database app).

| Step | State | Notes |
| --- | --- | --- |
| Hosted page, iframe and widget all run the same 5-step booking | Works | Customer → Appointment → Time → Details → Review, in the business's words. The customer is never asked whether they are new or returning; services that accept only one kind are chosen for them. Booking for someone else appears only when the business allows it |
| Booking form questions | Preview (routes tested in preview mode only) | Shown in the Details step when the chosen service has an active form; answers checked on the server, sealed, shown on the appointment page |
| New/returning, self/dependent, service, doctor or first available, time | Works | |
| Instant booking vs clinic approval | Works | Set per service |
| Manage link: confirm, reschedule, cancel, add to calendar | Works | |
| Where they came from | Works | Saved as `online` (hosted page), `widget` or `iframe`, with the referring site's host and UTM source, medium and campaign. Shown as "Booked through" on the schedule card and appointment page |
| What they want | Works | Optional "What is the visit for?" (reason for visit), shown to staff on the card and appointment page |
| Privacy and WhatsApp/SMS consent stored | Works | Privacy acceptance and reminder consent are saved with a time. The latest answer on the form replaces the stored one, so leaving the reminder box unticked switches that patient to email-only reminders |
| Returning patient matched to their existing record | Works | On the server, inside the booking transaction: same first and last name, email (any case) and phone (any spacing). Saved details are never overwritten from a public form; only an empty date of birth or accessibility need is filled. The audit records `patientMatch: returning` or `new` |
| Date of birth | Works | Optional on the public form and the staff screens, shown as age and date |

## 6. Patient arrives without the website

| Step | State | Notes |
| --- | --- | --- |
| Phone booking by staff, existing or new patient | Works | Saved with source `phone` and created confirmed, so a confirmation is queued straight away |
| Phone patient receives a manage link | Works | The result screen shows the link with a copy button for the receptionist to send or read out |
| Walk-in ("here now, no booking") | Works | New appointment → Walk-in. Shows today's openings from 15 minutes ago to 12 hours ahead, ignoring the online lead time. "Check in now" creates the visit already checked in, source `walk_in`, and sends no message |
| Server-side duplicate check | Works | A new-patient booking from staff goes through the same server match as the website. Add patient also warns about a likely duplicate by phone or email before saving |
| Add or edit a patient without booking | Works | Patients → Add patient, and Edit details on a patient. Edits send only changed fields; the audit names the fields, never their values |

## 7. In the clinic

| Step | State |
| --- | --- |
| Approve, decline, check in, complete, no-show, cancel, reschedule, mark form received | Works (version-checked, audited) |
| Start visit / time with doctor | Preview |
| Handover notes | Preview |
| Reason for cancel / no-show / decline | Missing (sent, not saved) |

## 8. Reports, WhatsApp and the patient portal

| Step | State | Notes |
| --- | --- | --- |
| Doctor writes a note, report or prescription; attaches PDF/JPG/PNG | Works | Encrypted at rest |
| Share with patient / withdraw | Works | Every view is logged |
| Patient signs in to the portal with a one-time code | Works | Email code needs Resend; phone code needs an SMS provider |
| Patient opens and downloads shared documents | Works | After date-of-birth or staff confirmation |
| Booking, change and "report ready" messages are generated | Works | Outbox + worker |
| **Messages actually reach WhatsApp / SMS / email** | Missing | Captured locally only; website bookings always routed to email |
| Reminders before a visit | Missing | Nothing schedules them |
| Delivery status (sent, delivered, read, failed) in Messages | Missing | |
| Patient replies on WhatsApp (confirm, reschedule) | Missing | |

## 9. After the visit and leaving the system

| Step | State |
| --- | --- |
| Waitlist status, recall contacted/snoozed | Works |
| Create a recall or follow-up when a visit is completed | Missing |
| Add someone to the waitlist from a screen | Missing (API only) |
| Edit, archive, anonymise or delete a patient | Missing |

## 10. Running the business

| Area | State |
| --- | --- |
| Clinic details, services, booking mode, working hours, blocked time, website snippet | Works |
| Second location, edit/remove rooms, booking policies (lead time, advance window, buffers) | Missing |
| Reminder settings, online-booking switch | Preview |
| Reports: visits, no-shows, sources, doctor utilisation, exports | Missing (sources are now recorded per booking) |

## Build plan

Each phase is shippable on its own and ends with a browser walkthrough on the database app.

1. **Team access and permissions.** *(Done 11 November 2026.)* Invite by email link with set-password, password reset, change role, billing and read-only accounts, per-person permission overrides on top of role presets, revoke sessions on deactivate, "My profile" (doctors edit their own profile and hours when allowed), audit log viewer with what changed.
2. **Patient entry and source.** *(Done 11 November 2026.)* Record source (hosted, widget, iframe, phone, walk-in) with referring site and UTM; reason for visit; stored privacy and messaging consent; server-side returning-patient match; walk-in "arrived now" path; date of birth; add/edit patient screen; manage link for phone bookings.
3. **Visit lifecycle and exit.** Persist visit start and timings, handover notes and status reasons; on completion offer follow-up or recall; waitlist add screen; archive and anonymise a patient.
4. **WhatsApp, reminders and report delivery.** Channel adapter with WhatsApp Business as the first provider, approved message templates, reminder scheduler, "your report is ready" message linking to the portal, delivery-status webhooks into Messages, patient replies to confirm or reschedule.
5. **Business management and reports.** Locations, room edits, booking policies, saved reminder settings; reports for bookings by source, no-shows, cancellations, doctor utilisation and records shared, with CSV export.

### Needs from outside the code

- A WhatsApp Business account (Meta Cloud API or an Indian BSP such as Gupshup/Interakt), a verified business number and approved templates.
- For SMS in India, DLT registration of the sender and templates.
- A verified email domain for Resend.
- Consent wording and retention policy reviewed before any live patient is messaged.
