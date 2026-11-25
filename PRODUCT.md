# Product

## Register

product

## Users

Kalendr serves customers and business teams in small appointment-led businesses: clinics and dental practices, salons, spas and gyms, estate agencies, consultants and other professional firms, shops that book fittings or consultations, tutors and coaching centres, and any other business that runs on appointments. It starts in India, with an architecture that can later be localized for other jurisdictions.

Each business picks a business type when it signs up. The type sets the words every screen uses (a clinic has patients, doctors and visits; a salon has clients, stylists and stations; an estate agency has clients, agents and viewings), its starter services, and which features are on. The owner can rename any word and switch features in Settings > Business profile. This document uses the neutral words: customer, provider, business, appointment, service, resource and location.

- Customers book for themselves from a phone, often while distracted, in transit, or outside opening hours. Where the business allows it, they can also book for a child or another family member. They need to find a suitable service and time, understand what happens next, and manage the booking without creating an account. Customers who come back can sign in with a one-time code to see every appointment and the people they book for. An account is always optional, and booking never requires one.
- Front-desk staff and managers work in a busy, interruption-heavy place. They need a dependable day board, fast customer lookup, clear action queues, conflict-free rescheduling, and an auditable view of what changed.
- Providers (doctors, stylists, agents, consultants, tutors and so on) need an accurate personal schedule, the customer details that matter for the appointment, including any accessibility needs and the answers to the business's booking questions, and minimal exposure to administrative noise.
- Owners and administrators set up locations, services, providers, resources (rooms, chairs, stations, properties and so on), booking forms, policies, permissions, reminders, waitlists, follow-ups, website connections, and operational reporting.

When the business type is healthcare or dental, customers are patients and guardians, providers are practitioners, resources are rooms or dental chairs, and practitioners also have a simple way to record a visit and send a report or prescription to the patient through the records area.

The primary task on a booking or manage-booking screen is to secure or manage one appointment with confidence. The primary task in the customer portal is to find the next appointment, or for healthcare and dental the latest document, without calling the business. The primary task on a front-desk screen is to identify the next operational action and complete it without creating a scheduling conflict. For healthcare and dental, the primary task in Records is to file a visit's documents and decide what the patient sees.

## Product Purpose

Kalendr, by Khanect, is a multi-tenant appointment platform that any appointment-led business can set up from one link. It combines customer self-service booking with business-controlled approvals, provider and resource availability, confirmations, rescheduling, cancellation, check-in, waitlists, follow-ups, custom booking forms, reminders, and auditable operations. A customer portal lets people see and change their appointments. For healthcare and dental businesses, a separate records area lets the practice hand patients their visit notes, reports and prescriptions.

An owner signs up at `/start`, picks a business type, and finishes setup with a live booking link at `/book/<slug>` that can be copied or shared straight away. That link can later be connected to an existing website as a normal link, a responsive iframe, or a small loader that opens the booking flow in a modal. A business without a website can take bookings from the hosted page within minutes.

Each business can build its own booking forms: the questions a customer answers while booking, attached to all services or chosen ones. Answers are stored sealed, shown to staff on the appointment page, and kept out of messages.

Success means customers can complete a valid booking without calling the business, staff can run the day from one clear workspace, double-booking is prevented at the database boundary, and every sensitive action is attributable.

## Product Boundary

Kalendr is an appointment system. It is not a point-of-sale, billing, marketplace, or customer-relationship platform, and it does not claim compliance with any privacy or sector law or standard.

- Booking form answers are seen only on the appointment page by staff who can open that appointment, each view is logged, and answers never appear in notifications, the message outbox, or the activity log.
- A business collects only what it asks for. Kalendr's own fields stay minimal, and medical wording appears only when the business type is healthcare or dental.

When the business type is healthcare or dental, Kalendr can also hold and share visit documents. Even then it is not a full EHR or EMR, a diagnostic system, a telemedicine system, or an emergency-care channel.

- Records live in their own area with their own permissions, and the area exists only when the records feature is on. Front-desk screens, the schedule, the Today board, and patient messages carry no clinical content.
- Receptionist, billing, and read-only roles cannot open records. Doctors see records for their own patients. Owners and admins see all of the practice's records and the access log.
- A patient sees only what the practice has chosen to share, after proving who they are. Reaching a shared phone or inbox shows appointments, never documents, because families share both.
- Each business keeps its own record. Sharing between organisations is not built and needs patient consent and legal review first.

## Brand Personality

Calm, trustworthy, and efficient. The product should feel composed under pressure, use plain language, and take the customer's time and details seriously without becoming cold or institutional. Customer surfaces should reduce uncertainty; staff surfaces should reward scanning, keyboard use, and confident action. The tone fits a clinic and a salon equally well: never clinical by default, never playful at the expense of clarity.

## Anti-references

- For healthcare and dental businesses: generic hospital-blue interfaces that rely on medical clichés, crosses, heartbeats, or stock-doctor imagery for trust. For every business: stock imagery or industry clichés standing in for real information.
- Childish lifestyle products with toy-like illustrations, excessive rounded shapes, celebratory motion, or vague reassurance.
- Heavy enterprise scheduling or practice-management software with dense chrome, cryptic abbreviations, hidden actions, and modal-first workflows.
- Consumer marketplaces that prioritize provider promotion, ratings, or upsells over the customer completing a booking.
- AI-product styling such as purple gradients, glassmorphism, glowing controls, oversized metric cards, and decorative automation language.

## Design Principles

1. **One next action.** Every state makes the customer or staff member's next safe action obvious without hiding alternatives.
2. **Calm is operational clarity.** Reduce anxiety with accurate availability, explicit policies, predictable states, and plain-language confirmations rather than decorative softness.
3. **Privacy by restraint.** Collect, reveal, message, and log only what the task requires. Booking form answers stay on the appointment page and out of messages. For healthcare and dental, clinical content stays out of the appointment flow and inside Records, every view of it is logged, and a message only ever says that a document is ready, never what it contains.
4. **Business rules remain authoritative.** Online convenience never bypasses provider, location, resource, lead-time, cancellation, consent, or approval policies.
5. **Familiar patterns, exceptional execution.** Use standard calendars, forms, tables, queues, and navigation with strong accessibility, responsive structure, and complete interaction states.
6. **The business's own words.** Every screen, message and calendar file uses the words the business chose. A salon never sees "patient"; a clinic still reads exactly as it expects.

## Accessibility & Inclusion

Target WCAG 2.2 Level AA across public booking, manage-booking links, the customer portal, booking forms, and the staff application. Support complete keyboard operation, visible focus, screen-reader names and announcements, non-color status cues, minimum touch targets, accessible authentication, error summaries, autocomplete, zoom and reflow, reduced motion, and a list-based alternative to calendar interactions.

Use plain language suitable for customers with varied literacy, including health literacy where the business is healthcare or dental. Avoid redundant data entry, preserve progress where safe, display the business's timezone and locale clearly, and allow customers to record accessibility or accommodation needs without exposing unnecessary details. Booking-for-someone-else flows (guardians and dependents in healthcare) must keep identities, authority, contact routing, and privacy boundaries explicit.
