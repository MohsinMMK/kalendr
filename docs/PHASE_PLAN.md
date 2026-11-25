# Kalendr delivery plan

> Note: Kalendr now serves any appointment-led business, not only clinics (see [PRODUCT.md](../PRODUCT.md) and [KALENDR_PLAN.md](KALENDR_PLAN.md)). This document is kept as history and still describes the clinic-only product.

This plan turns the approved product direction into a production-shaped, testable appointment application. The implementation deliberately keeps clinical records, diagnosis, prescriptions, billing, and emergency care outside the scheduling boundary.

## Phase 1 — Discovery and operating model

- [x] Map the patient journey from discovery through confirmation, reminders, arrival, completion, cancellation, and rescheduling.
- [x] Map front-desk, practitioner, manager, and owner workflows.
- [x] Model approvals, conflicts, buffers, rooms or dental chairs, waitlists, follow-ups, and recalls.
- [x] Research India-first privacy and security duties, with adaptable GDPR and HIPAA controls.
- [x] Define the MVP boundary and explicitly exclude EHR, diagnosis, billing, and emergency triage.

## Phase 2 — Product and experience direction

- [x] Establish the Kalendr product contract in `PRODUCT.md`.
- [x] Approve the calm, trustworthy, efficient visual direction.
- [x] Approve the hybrid operations workspace: vertical calendar, prioritized queues, resource visibility, and persistent context.
- [x] Define accessibility, responsive, copy, interaction, and motion principles.
- [x] Capture the implemented design system and component grammar in `DESIGN.md`.

## Phase 3 — Technical foundation

- [x] Scaffold Next.js App Router, React, TypeScript, Tailwind CSS, and a strict lint/test toolchain.
- [x] Establish typed appointment domain models and request contracts.
- [x] Add PostgreSQL and Drizzle schema, tenant isolation policies, migrations, and conflict-proof scheduling constraints.
- [x] Add authentication, role-aware authorization, audit events, idempotency, rate limits, and transactional notification foundations.
- [x] Add secure environment configuration and local container setup.

## Phase 4 — Patient self-service

- [x] Build the mobile-first booking sequence: clinic, service, practitioner, location, date, slot, patient details, review, and result.
- [x] Support booking for self or a dependent, accessibility needs, plain-language consent, and minimal data collection.
- [x] Build private manage-booking flows for confirmation, cancellation, and conflict-safe rescheduling.
- [x] Provide complete empty, loading, error, expired-link, and slot-lost states.

## Phase 5 — Clinic operations

- [x] Build the approved responsive application shell and day schedule.
- [x] Build approval, waitlist-match, reminder, arrival, no-show, completion, and follow-up actions.
- [x] Build searchable patient context, follow-up workspace, and clinic configuration surfaces.
- [x] Preserve practitioner, location, room/chair, service duration, and buffer context throughout changes.

## Phase 6 — Website connection

- [x] Provide a hosted booking URL for clinics without a website.
- [x] Provide copy-paste link, iframe, and modal-loader integration modes for existing websites.
- [x] Enforce an allowlisted parent origin, scoped postMessage contract, secure headers, and accessible modal behavior.
- [x] Include a runnable integration example and setup documentation.

## Phase 7 — Consolidated verification and hardening

- [x] Install-lock verification and migration generation.
- [x] Lint with zero warnings and run strict TypeScript checks.
- [x] Run unit and component tests once the full implementation is assembled.
- [x] Create a production build.
- [x] Exercise the patient and staff journeys in a real browser at desktop and mobile widths.
- [x] Review accessibility, responsive overflow, keyboard operation, console output, and representative failure states.
- [x] Reconcile documentation, implementation, and known production prerequisites.

## Production gates outside this repository

The prototype can be fully built and locally verified without external credentials. A live rollout still requires the clinic owner to choose and authorize hosting, domain/DNS changes, a production PostgreSQL service, email/SMS providers and sender identities, staff accounts, retention periods, legal notices and consent wording, data-processing agreements, incident contacts, and a jurisdiction-specific legal review.
