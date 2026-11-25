# Campaigns and win-back (feature 28)

Automated recall, birthday, win-back and package-expiry messages, and one-off messages to a segment, sent only to customers
who agreed to marketing, with a working unsubscribe, quiet hours and a limit of one marketing message per customer per week.

## What was built

| Part | Where |
| --- | --- |
| Tables (migration `0069_campaigns`) | `campaigns`, `campaign_sends` (unique per campaign, customer and cycle), `marketing_preferences`; new consent source `unsubscribe_link`; the marketing WhatsApp and text templates are added to `message_templates` as `pending` |
| Server | `src/server/campaigns/` — `audience.ts` (one definition of "who", used to count, to fan out and to re-check), `send.ts` (fan-out, hand-off), `attribution.ts` (credit bookings, results), `health.ts` (auto-pause, finishing), `service.ts` (web side), `tokens.ts`, `unsubscribe.ts` |
| Routes | `/api/staff/campaigns` (+ `options`, `presets/[key]`, `[id]`, `[id]/status`, `[id]/audience`, `[id]/preview`, `[id]/test`), `/api/public/unsubscribe/[token]` (GET and one-click POST), page `/unsubscribed` |
| Worker | minute job `campaign-tick`; outbox events `campaign.fanout`, `campaign.send`, `campaign.test` (see [WORKER.md](WORKER.md)); SQL functions `kalendr_campaign_tenants(job)` (ids only, worker only) and `kalendr_resolve_unsubscribe(hash)` (hash to business, send and customer) |
| Screen | `src/features/clinic/campaigns-workspace.tsx` |

## How a message gets sent

1. **Fan-out.** An automated campaign runs once a business-local day, a one-off once when it is due. It writes one `campaign_sends` row per customer, spread at 60 (email) or 30 (WhatsApp, text) a minute. The unique key (campaign, customer, cycle) means a restart creates nothing twice. `cycle` is empty except for birthdays (the year) and package expiry (the package), so those can come round again.
2. **Hand-off.** Each minute, due rows are claimed with `skip locked` and put on the outbox. During quiet hours (the business's workflow quiet hours) nothing is handed on and waiting rows move to the end of them. A paused, cancelled or finished campaign hands nothing on, so resuming carries on where it stopped.
3. **Send.** The handler claims the row by its status, re-checks everything for that one customer (consent, age, blocked, channel opt-out, a booking coming up for the service, the seven-day limit), builds the message with a booking link carrying the campaign's code and an unsubscribe link, and sends through the same sink and adapters as every other message. The semantic key is the provider's idempotency key, so a worker that dies after the provider accepted a message and comes back finds it already sent.

## Who is included

A customer is in an audience when the rule or segment picks them **and** they: have not been blocked, erased or merged away; are an adult and not a dependant; agreed to marketing (latest `marketing_messages` consent is a yes); have not opted out of this channel (WhatsApp and text also need their messaging consent unless they chose the channel in `marketing_preferences`); have an email address or phone number; have no booking coming up for the same service (any service for win-back and package expiry); and have had no other marketing message in 7 days. The owner sees how many were left out and why, with the order of reasons fixed. "Reply STOP" on WhatsApp and the unsubscribe link both withdraw marketing consent immediately; appointment reminders are never affected.

Recall catches a customer from the day the interval since their last visit for the service has passed, and for the next 30 days (so switching it on does not message everyone who lapsed years ago; that is what win-back is for).

## Credit for bookings

Every link carries `utm_campaign=<campaign code>`. A booking by that customer (or under another record with the same email or phone) made with that code within 7 days of the message is credited, once, to the campaign. Revenue is money received for the credited booking, net of refunds.

## Limits and safety

- Test before a one-off goes out: "Send me a test" goes to the owner (their sign-in email, or their own number for WhatsApp and text); a campaign can be turned on only when its current words were tested. Ready-made automated campaigns need no test.
- A campaign pauses itself after 20 settled messages when more than 15% failed or more than 3% of recipients unsubscribed, and a notice appears under the bell for people who run campaigns.
- WhatsApp sends only approved templates (marketing category) and counts against the plan's allowance, with the overage setting deciding whether past-allowance marketing stops (feature 14). Text uses an approved DLT promotional template.
- Unsubscribe tokens are 256 random bits, stored as SHA-256 hashes (with a sealed copy so a retried send builds the same link). The public link is rate limited, answers a dead link the same way as any other, and carries no business or customer in the address. Email carries `List-Unsubscribe` and `List-Unsubscribe-Post`.
- Nothing logs a name, address, number, token or message text; audit rows hold ids only.

## Known limits

- Review requests after a visit stay in workflows (feature 5); they use a different consent (`reviews`) and are not duplicated here.
- The cost shown for WhatsApp and text is an estimate from fixed unit prices in `src/lib/campaign-contracts.ts`; the provider's invoice decides.
- Link scanners that open every link in an email can unsubscribe a customer by mistake; mail apps that support one-click unsubscribe use the POST instead, which is the better path.
- Texts carry long links because the short-link domain is tied to appointments; a campaign short link is not built yet.
- Quiet hours are the business's workflow quiet hours; there is no separate setting for campaigns.
- Needs real accounts to go live: see "Needs your credentials" in the build report.
