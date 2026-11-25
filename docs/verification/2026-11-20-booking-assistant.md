# 2026-11-20: AI booking assistant (feature 30)

What was tested, and how.

## Against a real database (PostgreSQL, non-owner runtime role, forced row-level security)

- `src/server/assistant/assistant.integration.test.ts`: a whole website conversation through a scripted model books a real slot after the Confirm (source `assistant`, customer record made, messages sealed); a typed "yes" right after a proposal confirms; a model that lies "you're booked" with no confirm changes nothing; invented times, extra arguments, unknown tools, ids the chat never showed and another customer's booking are all refused by the tools; the phone code is required before bookings are shown or changed, only that number's bookings are reachable, and the six digits never reach the model or the stored chat; emergency and advice questions get the fixed reply and a handoff with no model call, and "book me in for a toothache" is not intercepted; "ignore your rules" and a typed `[SERVER NOTE]` change nothing; the monthly cap and a missing model fall back to the booking link; business B cannot read business A's chats or settings; settings save with a version check and an audit row that holds no words; the copilot finds a gap and books only after the staff member confirms, with audit rows `confirmed: false` for every tool call and `confirmed: true` for the confirm.
- `src/worker/handlers/assistant-inbound.integration.test.ts`: a signed WhatsApp webhook only queues; the worker runs the model, a "yes" books the customer's own record (not what the model typed), a repeated webhook answers once, a symptom question is handed off, and later messages reach staff without a model call.
- `src/worker/handlers/assistant-inbound-fallback.integration.test.ts`: with no model, or past the cap, a WhatsApp message still reaches staff with their alert, as before the assistant existed.
- `src/server/assistant/assistant-privacy.integration.test.ts`: chats appear in the customer's export, are erased with the customer, and are removed by the nightly retention job after the owner's number of days.

## Unit and component tests

Guardrails (emergency, advice and handoff phrases with false-positive cases), the tool list (fixed, closed to extra fields, no tenant or business input, no commit tool), the system prompt, the real model client against a local stub (cache markers, no rejected parameters, errors mapped without the provider's text), contracts, the widget and the settings screen.

## Browser (Playwright, production build, desktop and phone width, with axe scans)

`e2e/booking-assistant.spec.ts` (book by chat, Confirm, the booking on the front desk's list as "Booking assistant", reload keeps the chat, safe reply, switched-off business has no button), `e2e/booking-assistant-settings.spec.ts`, `e2e/booking-assistant-copilot.spec.ts`.

## Not done

The real model was never run (no API key). See "Known limits" in [../booking-assistant.md](../booking-assistant.md).
