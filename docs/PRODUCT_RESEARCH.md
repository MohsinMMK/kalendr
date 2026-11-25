# Kalendr product research and decisions

> Note: Kalendr now serves any appointment-led business, not only clinics (see [PRODUCT.md](../PRODUCT.md) and [KALENDR_PLAN.md](KALENDR_PLAN.md)). This document is kept as history and still describes the clinic-only product.

Research snapshot: 31 August 2026. This document records the operating assumptions behind the prototype and the decisions that should remain visible when Kalendr is adapted for a real clinic. It is product and engineering guidance, not legal or clinical advice.

## 1. Problem framing

Small clinics do not only need a public calendar. An appointment touches patient discovery, service selection, practitioner and resource availability, clinic approval, reminders, changes, arrival, the outcome of the visit, follow-up, and eventual recall. A useful product therefore has to join two journeys:

1. A patient must be able to book or request an appropriate visit, understand its status, and change it without repeatedly calling the clinic.
2. A clinic team must be able to protect capacity, assess requests, communicate changes, run the day, and preserve an attributable history.

The NHS e-Referral Service is much larger than Kalendr's target market, but its public workflow is useful evidence: patients can choose a service, date, time, and location, review before booking, then check, change, or cancel online; when no slot exists, a provider worklist takes over rather than abandoning the request. It also preserves telephone support for people who cannot use the online route. Kalendr adopts those interaction principles without copying the NHS referral or clinical-information scope.

## 2. Patient journey

### Before booking

The entry point should explain what the clinic offers, where the visit occurs, whether a chosen practitioner is required, expected duration, booking/approval policy, cost information when the clinic elects to show it, and how to contact the clinic. It must make clear that the booking flow is not emergency care.

### Booking sequence

The sequence is intentionally progressive:

1. New or returning patient, booking for self or dependent.
2. Location and service.
3. Preferred practitioner or first available.
4. Date and an actually available slot, shown in the clinic's timezone.
5. Minimal contact details, preferred reminder channel, and optional accessibility/accommodation note.
6. A complete review screen containing service, practitioner, location, start/end, policy, and contact route.
7. A definitive result: confirmed, requested and awaiting approval, waitlisted, or not completed.

Account creation is not required. The patient receives a high-entropy private manage link. The result screen is not treated as proof that an uncertain network request failed; idempotency prevents accidental duplicates when a submission is retried.

### After booking

From the manage link a patient can:

- see the authoritative status and clinic contact details;
- confirm attendance when the clinic requests it;
- reschedule against newly checked availability;
- cancel with the applicable policy and an optional reason;
- see what changed and what happens next;
- add the appointment to a normal calendar;
- request human help when self-service is unsuitable.

Sensitive appointment details must not appear in the token URL, notification preview, browser title, analytics payload, or generic error message.

### Failure and edge states

- A slot that becomes unavailable during review returns a recoverable conflict and preserves the rest of the draft.
- No matching slot offers other practitioners, nearby dates, another location, or a waitlist/request path.
- Expired or revoked manage links reveal no patient data and direct the user to the clinic.
- A cancelled appointment remains auditable but is not presented as active.
- Network uncertainty separates “we could not confirm the result” from “the booking failed.”
- Online booking always has a clinic phone alternative.

## 3. Clinic operating model

### Roles

- **Receptionist:** day schedule, patient lookup, request approval, changes, arrival, reminders, and waitlist offers.
- **Practitioner:** own schedule and the minimal logistics needed for each visit.
- **Manager:** all operational views plus services, resources, policies, staff access, recalls, and reporting.
- **Owner/admin:** tenancy, security, integrations, legal notices, provider configuration, retention, and export controls.

Authorization is clinic-scoped and deny-by-default. A role label in the interface is never sufficient authorization; every server operation must re-evaluate clinic membership and permission.

### Appointment state model

Kalendr's operational states are aligned with the semantics in HL7 FHIR Appointment while remaining small enough for independent practices:

```text
requested -> booked -> checked_in -> completed
     |          |             |
     +------> cancelled <------+
                |
booked ------> no_show
any mistaken record -> entered_in_error
```

Confirmation is a separate participant state (`needs_action`, `confirmed`, or `declined`) because a booked clinic slot and a patient's response are related but not identical facts. Every transition records actor, time, previous state, new state, reason where required, and outcome.

### Prioritized work queues

The staff home is an action workspace rather than a collection of vanity metrics:

1. Requests needing approval or clarification.
2. Arrivals and active appointments today.
3. Unconfirmed visits approaching the clinic's threshold.
4. Failed or undelivered reminders.
5. Waitlist candidates for newly opened capacity.
6. Follow-ups and recalls due.

Each queue supports a safe primary action, a route to full patient/appointment context, filters by location and practitioner, and a visible empty state. Work is never silently removed after failure.

### Availability and resources

A slot is valid only when all required constraints agree:

- clinic and location opening hours;
- practitioner schedule, leave, and existing bookings;
- service eligibility and patient type;
- duration plus preparation/cleanup buffers;
- lead time, booking horizon, and cancellation rules;
- location-specific room, dental chair, operatory, or equipment;
- temporary blocks and exceptional closures;
- timezone and daylight-saving behavior for future international use.

The interface checks constraints for fast feedback. PostgreSQL remains the final concurrency boundary: range exclusion constraints reject overlapping active bookings for the same practitioner or resource even when two requests race.

### Waitlists, follow-ups, and recalls

A waitlist record carries service, location, practitioner preference, date range, time preference, patient contact route, and a lifecycle (`active`, `offered`, `fulfilled`, `expired`, `declined`). An offer temporarily reserves capacity and expires; it does not silently create a confirmed appointment.

A follow-up is a task tied to an appointment or patient. A recall is a future care reminder tied to a service and due date. Neither should contain diagnosis or treatment notes in the scheduling product.

## 4. Notifications and external calendars

Appointment writes and messages use a transactional outbox so a successful booking cannot be lost merely because an email or SMS provider is temporarily unavailable. Deliveries have queued, delivered, failed, and retry states. Templates avoid sensitive clinical detail and identify the clinic clearly.

Reminder timing is clinic-configurable. Dental evidence reviewed for this project supports layered reminders and a standby/waitlist process as operational strategies; the software provides the mechanism but does not impose one policy on every clinic.

Calendar export follows iCalendar (RFC 5545) with a persistent globally unique `UID`, explicit timezone handling, and safe updates/cancellations. Two-way Google or Microsoft calendar synchronization is a later integration because it adds OAuth consent, provider-specific conflict semantics, webhook renewal, and reconciliation work.

## 5. Existing-website connection

Kalendr supports three deliberately incremental modes:

1. **Link:** the clinic adds a normal button pointing to its hosted booking page. This is the most compatible and easiest to audit.
2. **Iframe:** the complete public booking route is embedded in a responsive frame. Parent origins are allowlisted and frame ancestors are restricted.
3. **Modal loader:** one small script inserts an accessible Book appointment trigger and opens the booking page in a dialog.

The embedded application and parent page exchange only versioned, allowlisted messages such as ready, resize, close, and booking-complete. Both sides validate `origin`; no patient details are sent to the parent. The loader preserves focus, supports Escape, restores focus on close, avoids taking over host-site typography, and provides a direct-link fallback when JavaScript or framing is blocked.

## 6. India-first privacy and security

### Current legal posture

India notified the Digital Personal Data Protection Rules, 2025 and the matching Act commencement schedule on 13 November 2025. The commencement is phased: some institutional provisions began on publication, another set begins after one year, and the major processing obligations and Rules 3, 5–16, 22, and 23 begin eighteen months after publication (13 May 2027). Kalendr should build toward those duties now, but a clinic must not represent future-phase compliance as already legally certified.

Until the transition is complete, the Information Technology Act/section 43A and the Information Technology (Reasonable Security Practices and Procedures and Sensitive Personal Data or Information) Rules, 2011 remain an important operational baseline for health and medical information handled by a body corporate. Final applicability and the effect of later notifications require Indian counsel for the particular clinic and operating model.

CERT-In's 2022 directions apply broadly to service providers and bodies corporate. Covered incidents, including data breaches or leaks, may need reporting within six hours of noticing them; available information can be supplied first and supplemented later. Production operations therefore need an incident contact, clock synchronization, retrievable logs, a response runbook, and vendor notification clauses—not only application code.

ABDM's Health Data Management Policy informs privacy-respecting health-data design, but an ordinary clinic scheduler is not automatically ABDM-certified or an ABDM Health Information User/Provider. ABHA linkage and ABDM consent artefacts remain an explicit later integration.

### Product controls derived from the research

- Collect only scheduling and contact data needed for the declared purpose.
- Present a standalone, plain-language, itemized privacy notice at collection.
- Keep consent evidence versioned and withdrawal/help routes easy to find.
- Separate dependents and guardians explicitly; do not infer authority from a shared phone number.
- Keep diagnostic notes, prescriptions, images, and full medical history outside the appointment database.
- Encrypt transport, use managed storage encryption, rotate secrets, and keep production credentials out of source.
- Use short-lived sessions for staff, high-entropy hashed manage tokens for patients, role/tenant checks, and audit events.
- Do not log tokens, free-text patient notes, message bodies, or unnecessary identifiers.
- Make retention and deletion schedules configurable only after the clinic chooses a lawful policy.
- Maintain export, correction, grievance, breach-response, and processor-management procedures before live use.

### International adaptation

For a US deployment, whether Kalendr is a HIPAA business associate depends on the customer and data flow; a signed business associate agreement, HIPAA risk analysis, administrative/physical safeguards, and provider contracts are external requirements. For EEA/UK use, controllers must define a lawful basis, processor terms, data-subject workflows, retention, international transfer mechanisms, and breach procedures. The architecture supplies isolation, minimization, access control, and audit foundations but does not itself confer compliance.

## 7. Accessibility and inclusion

Kalendr targets WCAG 2.2 Level AA. The practical requirements that matter most to these flows are:

- visible and unobscured focus;
- keyboard-complete operation with no drag-only calendar action;
- programmatic labels, names, roles, errors, and status announcements;
- minimum target sizing and generous coarse-pointer targets;
- a list-based slot alternative to spatial calendar controls;
- no redundant re-entry when data is already available safely;
- accessible authentication without cognitive-function tests;
- 200% zoom and narrow-screen reflow without horizontal page scrolling;
- reduced motion and non-color status cues;
- plain language and an explicit phone/help alternative.

Conformance is assessed across the complete booking and manage-booking processes, including responsive variants and error states—not only the landing page.

## 8. Technical architecture decision

The initial product is a modular monolith: one Next.js application, one PostgreSQL database, clear domain modules, server-side authorization, and provider adapters at the edges. This keeps deployment and operations realistic for a small product team while preserving boundaries that can be extracted later.

Key decisions:

- Multi-tenant rows carry a clinic identifier and production policies enforce tenant isolation.
- Public booking uses opaque clinic slugs and limited public data, never staff APIs.
- Availability is computed from canonical schedules and revalidated in the booking transaction.
- Active practitioner/resource periods are protected by PostgreSQL range exclusion constraints.
- Writes use idempotency keys and optimistic versions; conflict responses are explicit and recoverable.
- Notifications use an outbox and asynchronous provider adapters.
- Audit records are append-only and store identifiers plus action metadata rather than payload snapshots.
- API contracts return stable success/error envelopes and do not expose internal exceptions.
- The app works as a responsive web/PWA surface; native applications are unnecessary for the first release.

## 9. MVP and later scope

### MVP

- Hosted, linked, iframe, and loader-based patient booking.
- Instant and approval-required appointments.
- Practitioner, location, service, buffer, and resource constraints.
- Confirmation, cancellation, rescheduling, arrival, completion, no-show, and error correction.
- Reminders, waitlist offers, follow-up tasks, and recalls.
- Patient search and scheduling history.
- Staff roles, audit events, and core configuration.

### Explicitly later

- EHR/EMR records, clinical charting, diagnosis, imaging, prescriptions, and lab workflows.
- Payments, insurance claims, invoices, and accounting.
- Telemedicine and emergency triage.
- AI clinical recommendations or symptom assessment.
- Native mobile applications.
- Marketplace discovery, public ratings, and practitioner advertising.
- Full ABDM, FHIR server, Google/Microsoft two-way calendar, or hardware integrations.
- Analytics that require patient-level warehouse replication.

## 10. Primary sources

- [Digital Personal Data Protection Rules, 2025 — Gazette notification, MeitY](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf)
- [DPDP Act commencement schedule — Gazette notification, MeitY](https://www.meity.gov.in/static/uploads/2025/11/c56ceae6c383460ca69577428d36828b.pdf)
- [Digital Personal Data Protection Act, 2023 — India Code](https://www.indiacode.nic.in/indiacode/handle/123456789/22037?view_type=browse)
- [IT Act section 43A and SPDI Rules record — India Code](https://www.indiacode.nic.in/handle/123456789/1362/simple-search?query=The+Information+Technology+%28Reasonable+Security+Practices+and+Procedures+and+Sensitive+Personal+Data+or+Information%29+Rules%2C+2011.&searchradio=rules)
- [CERT-In Cyber Security Directions FAQs](https://www.cert-in.org.in/PDF/FAQs_on_CyberSecurityDirections_May2022.pdf)
- [ABDM Health Data Management Policy](https://abdm.gov.in/static/media/health_management_policy_bac9429a79.80f74bc3e039c00acd4f.pdf)
- [WCAG 2.2 — W3C Recommendation](https://www.w3.org/TR/WCAG22/)
- [NHS e-Referral Service](https://digital.nhs.uk/services/e-referral-service)
- [Helping patients manage their referral online — NHS England Digital](https://digital.nhs.uk/services/e-referral-service/helping-patients-manage-their-referral-online)
- [Managing appointment slot issues — NHS England Digital](https://digital.nhs.uk/services/e-referral-service/document-library/managing-and-minimising-appointment-slot-issues)
- [Referring a patient and booking flow — NHS England Digital](https://digital.nhs.uk/services/e-referral-service/document-library/referring-a-patient)
- [HL7 FHIR R5 Appointment definitions](https://www.hl7.org/fhir/R5/appointment-definitions.html)
- [HL7 FHIR R5 Appointment status value set](https://hl7.org/fhir/R5/valueset-appointmentstatus.html)
- [PostgreSQL range types and exclusion constraints](https://www.postgresql.org/docs/current/rangetypes.html)
- [RFC 5545 — iCalendar](https://datatracker.ietf.org/doc/html/rfc5545)
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [EU General Data Protection Regulation](https://eur-lex.europa.eu/eli/reg/2016/679/oj)
- [US HHS HIPAA Security Rule guidance](https://www.hhs.gov/hipaa/for-professionals/security/index.html)
