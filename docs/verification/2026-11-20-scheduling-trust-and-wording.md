# Wave 3C: features 44, 45, 48, 50

Date: 20 November 2026. Scratch PostgreSQL 17 on port 5631, built with `scripts/e2e-database.mjs`; integration tests run with `KALENDR_TEST_SCRATCH_PORT=5631`.

| Feature | Done-when | Tested by |
| --- | --- | --- |
| 44 | Report a fake booking: it and its repeats are cancelled quietly and appear in the queue; blocking the email makes a dotted or +tagged variant show the normal confirmation with no appointment, message or held slot and one refused audit row without contact details | `src/server/spam.integration.test.ts`, `src/lib/spam-contact.test.ts` |
| 45 | A single-use link books once, then shows "already used"; two at once give one booking; an expired link refuses; a combined link offers only shared times and books two linked appointments | `src/server/special-links.integration.test.ts`, `src/lib/special-links.test.ts`, `src/features/booking/special-link-unavailable.test.tsx` |
| 48 | A locked price on 12 copies; description editable, price refused on every route; one publish updates all 12; earlier bookings keep their price | `src/server/service-templates.integration.test.ts`, `src/lib/service-templates.test.ts` |
| 50 | "{service} with {person}" appears in the invite; hide details writes only "Busy: business" (title, description and place asserted); a verified reply-to address is used as Reply-To | `src/server/calendar-wording.integration.test.ts`, `src/lib/event-wording.test.ts` |

Browser: `e2e/special-links.spec.ts` (desktop) passes for the used-link page and the combined link. Not done: browser journeys for the staff screens; see "Known limits" in [../scheduling-trust-and-wording.md](../scheduling-trust-and-wording.md).
