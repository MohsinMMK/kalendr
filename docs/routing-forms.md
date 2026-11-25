# Routing forms (feature 46)

A short form that sends each customer to the right service and the right person. A clinic asks "First visit?" and "Language?"; a first-time Tamil speaker lands on a consultation with a Tamil-speaking doctor, with the answers already filled in on the booking.

## How it fits together

| Piece | Where |
| --- | --- |
| Rules, schemas, trace and the unreachable-route check (pure, no database) | `src/lib/routing-forms.ts` |
| Fair-share ordering and the plain-words "why" | `src/lib/routing-rank.ts` (`explainAssignment`), `src/server/routing.ts` (`chooseAssignee` takes `candidateIds` and `weightMultipliers`) |
| Staff: forms, publish, preview | `src/server/routing-forms/forms.ts`, `src/app/api/staff/routing-forms/*` |
| Customers: read, open, answer | `src/server/routing-forms/public.ts`, `src/app/api/public/routing/[clinicSlug]/[formSlug]` |
| Token, booking link-up, trace on a booking | `src/server/routing-forms/trace.ts` |
| Report and CSV | `src/server/routing-forms/report.ts` |
| Wrong-assignment reports | `src/server/routing-forms/wrong-assignment.ts` |
| Screens | `src/features/clinic/routing-forms/` (builder, preview, report), `src/features/routing/` (public form, trace card), pages `/routing-forms` and `/f/<business>/<form>` |

Migration `0073_routing_forms`: `routing_forms`, `routing_form_versions`, `routing_responses`, `wrong_assignment_reports` (forced row-level security on each) and `campaigns_rule_ck` widened for the `routing_abandoned` rule. No new SQL function, so no REVOKE list changes. The attribute tables already existed from feature 53 and are reused.

## What a customer's journey does

1. `/f/<business>/<form>` shows the form. The page calls `…/open`, which writes a response row (the funnel's "opened" step) and returns an opaque 256-bit token. Only its SHA-256 hash is stored.
2. Answering posts the answers and the token. The server checks them against the form's stored version, finds the first route whose conditions hold, narrows the people by the route's rules, seals the answers with the business's key and stores the trace. It answers with one of: a booking address, another website, or a message. It never says who was matched or why.
3. The booking address is `/book/<business>?service=<id>&routing=<token>`. No answer is ever in a URL. The booking page reads the token on the server, fills booking questions that share a link name with a routing question (email and phone questions fill the contact step), shows only the people the form picked, and passes the token on to availability, the hold and the booking.
4. The browser never sends people or weights. The availability list, the hold and the booking commit each read the candidate set from the response row and refuse anyone outside it. A booking links the response, records which person got it and why, and sets the outcome to booked.

## Rules worth knowing

- Routes are checked in order. A service route that nobody fits (the people rule leaves no one) is passed over, so a customer is never sent to a doctor who does not match; the fallback catches the rest. A form cannot be saved without a fallback.
- A person filter on a question the customer left blank matches nobody. Nobody is picked on a guess.
- Attribute weights multiply a person's weight in feature 20's fair-share step (a Senior counts double). Everything else in the chooser is unchanged.
- Saving a live form does not change what customers see. Publishing copies it into an immutable version; responses keep the version they were answered with. A live form's address can only change while it is paused.
- Unknown, draft, paused and other-business forms all give the same 404.
- The preview runs in a read-only transaction and writes nothing (the integration test counts rows in six tables before and after).
- "Answered but did not book" is computed at read time: answered, sent to a service, not booked within two hours. It is not stored.
- The CSV has one row per response with route and funnel steps. It never contains answers or contact details.
- The trace holds the owner's rule text, ids and names, never what the customer typed. Free text stays out of audit rows. Erasing a customer clears the sealed answers.

## Headless use

A business's own website form can `POST` `{ "answers": { "<questionId>": … } }` to `/api/public/routing/<business>/<form>` (CORS is open for that endpoint only, with no credentials) and follow the returned address. Rate limits: 30 per minute per IP to open and to answer, 600 per minute per form, 120 reads per minute per IP.

## Plan and permissions

Staff writes need `routing.manage` and the `routingForms` plan feature (mapped to the plan's `reports` switch, so it comes with Growth and up and can be split later). Flagging a wrong assignment needs `routing.report` (receptionist and practitioner by default). Every write route calls `assertNotReadOnlyImpersonation`.

## The campaign trigger

The `routing_abandoned` campaign rule ("N hours after answering a form without booking") finds customers whose answers included an email that matches an existing customer, who have not booked since, within a three-day window. The usual campaign rules still apply: marketing consent, channel agreement, the seven-day gap, under-18s and blocked customers are left out. Anonymous visitors cannot be followed up, by design.

## Known limits

- The public form is not framable on other websites (the `/book` page is; `/f` was left out rather than touch the content security policy).
- The public form uses the business's words and brand colours but not its logo.
- Destinations are a service, an outside address or a message. A route cannot pick a location, a class, or a team page; the booking page offers the usual choices.
- Routing questions cannot be hidden, consent or guest-email questions, and are capped at 12 per form and 25 routes.
- The unreachable-route check tries every combination of the answers the routes look at, up to 20,000; a larger form is only checked for an earlier route with no conditions.
- The scratch tests ran on PostgreSQL 17, not 18.
