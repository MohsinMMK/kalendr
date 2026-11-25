# Customer profiles (27) and campaigns (28): what was tested

Run on 2026-11-20 against a scratch PostgreSQL on 127.0.0.1:5657 (database `kalendr_e2e`), with the web role and the worker role. Nothing was sent to a real provider: email goes to the fake provider, WhatsApp and text were checked up to the adapter's request.

## Done-when, feature 27

| Done when | Test |
| --- | --- |
| Opening a customer shows history in one timeline in under a second with 500 entries | `src/server/customers/customers.integration.test.ts` "opens a customer with 500 entries in under a second…" (300 visits and 200 notes; pages without a gap or repeat; kind filter) |
| A segment "no visit in 90 days, more than 3 visits, consents to marketing" shows a count that matches a hand query | same file, "counts 'no visit in 90 days…' exactly as a hand query does"; the count, the hand SQL and the listed members agree |
| Merging two profiles moves every appointment and payment and can be undone | "moves every appointment, payment and invoice's worth of history…" (appointment, visit payment, visit-less payment, note, tag; summary, lifetime value, timeline and undo checked); also replay by Idempotency-Key, step-up, permission, 30-day expiry and the purge job |
| A blocked customer cannot book online | "blocks and unblocks…" checks the guard the public booking and the waitlist call (`assertNotBlocked`) by the same email or phone, however written |

## Done-when, feature 28

| Done when | Test |
| --- | --- |
| "6-month recall" messages only customers who had that service six months ago, opted in, no future booking, each once | `src/server/campaigns/campaigns.integration.test.ts` "messages only customers who had the service six months ago…" (11 customers; counts of who is left out and why; second and third worker rounds send nothing) |
| STOP ends marketing but not appointment reminders | "lets a customer's STOP on WhatsApp end marketing while reminders carry on" and the unsubscribe-link test (consent withdrawn with source `unsubscribe_link`, appointment-message consent untouched) |
| A booking from the link shows against the campaign with its revenue | "credits a booking made from the link within 7 days, with its revenue, and not one made later" |
| Restarting the worker mid-send sends nothing twice | "sends nothing twice when the worker stops in the middle and comes back" (provider accepts, worker dies, comes back) and "never fans out twice and never sends a settled message again" |

Also covered: seven-day limit across campaigns, quiet hours and pause/resume, auto-pause on failures, test-before-send, the List-Unsubscribe headers and link in the real email adapter, approved-template rule for WhatsApp, row-level security and permission checks.

## Not tested against real services

WhatsApp and SMS sends (no Meta or DLT account), real email delivery (no verified sending domain), the 30-day wait for a merge to expire (set by editing the row), mail-app one-click unsubscribe. See "Needs your credentials" in the build report.
