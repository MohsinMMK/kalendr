# Customer sign-in upgrade (feature 8), 2026-11-19

Branch `claude/w2a-signin-waitlist-9af353`, migration `0050_customer_sign_in`.

## Done when

| Check | How it is tested |
| --- | --- |
| A customer with only a phone number signs in with a WhatsApp code | `src/server/patient-sign-in.integration.test.ts` (code sealed, sent as a copy-code authentication template, sealed copy cleared, code signs in); `e2e/customer-sign-in.spec.ts` (phone tab, capture server, wrong code waits, right code signs in) |
| The sixth code request in an hour from one network is refused | integration test (pinned window) and the Playwright spec (six different numbers, 202 x5 then 429 with Retry-After) |
| A manage link from 31 days ago no longer opens the booking | integration test (31 days closed, 29 open, moving the booking moves the expiry) and the Playwright spec (page and 410 from the API; nothing about the business shown) |
| Cancelling from a forwarded link asks for a code the forwarder does not have | integration test (grant is per booking, single use, paid always asks, another customer's portal session still asked) and the Playwright spec (forwarder opens the link, is asked, a guess fails, the right code cancels) |

## Also covered

Backoff after a wrong code, remember-this-device (30 days), devices list, sign out one and sign out the others (one account cannot end another's), rotation on reschedule (old link dead, sealed token is the new one, event queued after), step-up codes hidden across businesses, platform delivery table unreadable by the app role, contact-change notice to the other channel without the new contact, WhatsApp copy-code payload shape.

## Needs real accounts

WhatsApp: submit `kalendr_sign_in_code` (authentication, copy-code button) and `kalendr_contact_changed` (utility) to Meta. SMS: DLT approval for `sign_in_code` and `contact_changed`; replace the placeholder template ids. The step-up code reuses the sign-in code wording on WhatsApp and SMS.
