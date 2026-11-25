# Booking questions 2.0 (feature 40) — 19 November 2026

Built on `claude/w1c-sched-38-40-eb5e5f`. Migration `drizzle/0037_booking_questions.sql` (hand-written). Same database and caveats as the booking limits note.

## What was built

- **New question types**: pick one as cards (`radio`), checkboxes, a searchable multi-select, a web address, an address (street, city, state, PIN), guest emails and a split first and last name (`src/lib/booking-forms.ts`). Answers are stored sealed, like the existing ones.
- **Conditions**: a question can be shown only when an **earlier** answer is, is not, includes or is one of some values (up to three, all must hold). One pure function, `isFieldVisible`, is used by the builder, the booking page and the server. A question hidden by its conditions is not required and its answer is dropped on save, so a crafted request cannot store an answer the customer was never shown. A condition on a question that is itself hidden does not hold.
- **Prefill from the link**: a question's "link name" reads `?name=value`; values are checked against the question's type and length and invalid ones are ignored (`readPrefill`). "Lock when filled" shows the value read-only. A hidden question is never shown, only filled from the link (a campaign tag), and is stored with the answers when valid. The built-in names `name`, `email`, `phone`, `notes`, `guests` and `location` cannot be reused.
- **Required per service**: the same form can be required on one service and optional on another (`form_definition_services.required_overrides`).
- **Contact mode** (`services.contact_mode`): email or phone (at least one), email required, or phone only (no email asked or stored; the booking row keeps an empty address). Checked on the server (`booking-intake.ts`).
- **Guests** (`services.allow_guests`, `max_guests`): up to the service's limit; the list is sealed on the booking (`appointments.guest_emails_ciphertext`) and never logged. Guests get the confirmation and later updates through the same worker send, without the customer's private link, so they cannot manage the booking.
- **Email check** (`services.verify_email`, `email_checks`): the page asks for a 6-digit code; it is sent through the outbox (`email_check.code`, sealed for the worker and cleared once sent), kept as a keyed hash, valid 10 minutes, five attempts, five sends an hour per address, 20 an hour per network. The right code returns a one-use proof that the booking consumes inside its transaction.
- **Screens**: new types, a "Show this when…" row, hidden and locked switches and per-service required in the form builder; a "Contact and guests" tab in the service editor; the booking page renders the new types, hides and shows by condition, prefills from the link, takes guests, and runs the email check.

## Done when

| Criterion | How it was checked | Result |
| --- | --- | --- |
| "Have you visited before?" with "No" reveals "How did you hear about us?" and hides it on "Yes"; a crafted answer to the hidden question is dropped | `booking-questions.test.ts` (pure) and `booking-questions.integration.test.ts` (database, stored answers read back) | Pass |
| `?email=…&campaign=diwali` fills the email (locked) and stores the hidden campaign answer | `readPrefill` tests; the hidden answer is stored in the integration test; the locked email is a booking-page test | Pass |
| A couple's booking with one guest sends the confirmation to both | `booking-questions.integration.test.ts`: the real email adapter sends two messages, the guest's has no manage link | Pass |
| A phone-only service books without an email | integration test (and a booking with no phone is refused) | Pass |
| With email check on: a wrong code three times then the right one books; a sixth attempt is refused | integration test: three wrong, the right code books once, the proof cannot be reused or used for another address; five wrong guesses lock the code | Pass |

## Needs your credentials

- Email delivery (`RESEND_API_KEY`, `EMAIL_FROM`) for the code and guest confirmations to leave the machine. Locally they go to the capture server or the local capture sink.
- WhatsApp and SMS accounts (features 3 and 4) for confirmations to phone-only customers. Until those exist, a phone-only booking is taken and recorded but no confirmation is sent.

## Known limits

- A customer already signed in to the portal still gets the code step; skipping it needs the portal session on the public booking route.
- Guest emails receive messages through the email adapter only; guests have no sign-in or portal.
- Staff bookings from the workspace do not ask the new custom questions (they never did) and do not need the email check.
- The code email uses the business name only; it carries no logo yet.
