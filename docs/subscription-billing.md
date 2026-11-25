# Plans and subscription billing (feature 14)

Kalendr's own plans, paid by businesses. Customer payments to a business (feature 23) are separate: different tables, files and webhook events. Nothing here stores a card or UPI detail; the provider's own page or sheet collects those.

## Plans

| | Free | Starter | Growth | Scale |
| --- | --- | --- | --- | --- |
| Staff calendars | 1 | 3 | 10 | Unlimited |
| Locations | 1 | 1 | 3 | Unlimited |
| Bookings per month | 50 | Unlimited | Unlimited | Unlimited |
| WhatsApp / SMS included | none | 200 / 100 | 1000 / 500 | 5000 / 2500 |
| Online payments | no | yes | yes | yes |
| Own web address, no badge, reports, API, assistant | no | no | yes | yes |
| Price (INR, GST included / USD) | 0 | 499 / 9 | 1499 / 29 | 3999 / 79 |

The numbers live in the `plans` table (migration 0049) and in `src/lib/entitlements.ts`; a test keeps the two in step. Every new business gets a 14-day Growth trial with no card (`createTrialSubscription`, in the same transaction as the business). A business with no subscription row (a seeded dev business) gets its trial the first time its plan is read.

The plan a business can use right now is `effectivePlanKey`, computed from dates: a trial gives Growth until it ends, a failed renewal keeps the paid plan for 7 days, a cancelled plan lasts to the period end. The billing sweep only makes stored status match; it never decides what anyone can do.

## Where plans are enforced on the server

Every refusal is `ApiError` 402 `plan_limit` with `details` `{ subject, requiredPlan, currentPlan, limit }` and a sentence naming the plan that unlocks it. The screens open the upgrade dialog on that code. `getStaffContext` loads `context.entitlements` in the same scope as the security policy (one query for the subscription and all plan limits).

| Rule | Where |
| --- | --- |
| Create or re-activate a staff calendar | `createStaffPractitioner`, `updateStaffPractitioner` (`isActive: true`) in `src/server/staff-team.ts`, via `assertCanAddCalendar` (locks the subscription row so two creates at once are counted one by one) |
| Calendars over the limit after a downgrade (the newest) are read-only | edits refused in `updateStaffPractitioner` (`assertCalendarEditable`); no new bookings: `src/server/slot-engine/load.ts` leaves them out of slot lists, and `assertBookingAllowed` refuses them at commit. Deactivating is always allowed |
| Bookings per month (Free: 50) | `assertBookingAllowed` inside the public, staff and queue-door booking transactions (`appointment-repository.ts`, `queue-door.ts`). Counts appointments created this UTC month. Existing bookings are untouched. The public message does not mention plans |
| WhatsApp and SMS | worker: `planGatedSink` (`src/worker/plan-gate.ts`) wraps the sink for every handler |
| Locations | `assertCanAddLocation` is exported. **No staff route creates a location yet**, so it is not wired; call it where that route is built |
| Online payments, custom domain, calendar sync, reports, API, assistant | `requireFeature(context, "<feature>")` in `src/server/entitlements.ts`. None of those features exist on this branch yet, so none is wired; each feature calls `requireFeature` next to its `requirePermission` |

### Messages: the never-silently-stopped rule

`planGatedSink` decides with the pure `decideMessageGate` (`src/lib/billing-rules.ts`):

- Email always goes.
- A plan with no allowance on WhatsApp or SMS: confirmations, reminders, changes and cancellations (`appointment.created/confirm/status.booked/reminder/reschedule/suggest/cancel/status.cancelled`) go **by email** when the customer has an email that is not suppressed. With no usable email they are **sent anyway** on the original channel and an `audit_events` row `billing.protected_message_sent_without_allowance` is written. Anything else (review requests, waitlist offers) fails with `plan_channel_locked`: dead at once, never retried, visible under Failed.
- Past the monthly allowance: marketing-category messages (from `message_templates.cost_category`) stop with `plan_overage_stopped` when the owner chose `stop_marketing`, and are sent and counted (billed as overage) when they chose `bill_overage`. Utility messages are always sent.

### The usage meter

`recordMessageUsage` (`src/server/billing/usage.ts`) adds to `usage_counters` (period = first day of the UTC month): `message:<channel>`, `message:<channel>:<category>`, `message:sms:segments`. It is called by `providerSink` on the transition to sent, in the same transaction as the notification row, so a duplicate delivery (which returns before that point) or a retry cannot count twice; staff replies in the Inbox are counted by the thread-reply handler. Emails are counted too, for the meter only. At 80% and 100% of the included amount an owner email is queued once per month: the marker `whatsapp:80:2026-11` is stored in `usage_alerts_sent`, so a new month needs no reset. Messages sent in `local_capture` mode (no adapter) are not metered.

## Checkout, plan changes, cancel

Provider by business: `chooseBillingProvider` (one pure, tested function): non-INR currency is Stripe; INR with an Indian locale (`*-IN`) or Asia/Kolkata time zone is Razorpay; otherwise Stripe. Sign-up never asks for a country and `currency` defaults to INR, so locale and zone decide.

| Action | Route | What happens |
| --- | --- | --- |
| Read state | `GET /api/staff/billing` | owner and anyone with `settings.manage`; the past-due banner only for owners |
| Checkout | `POST /api/staff/billing/checkout` | permission `billing.manage`; optional `Idempotency-Key`. Creates a Razorpay subscription (UPI Autopay or card, opened in Razorpay's sheet) or a Stripe Checkout session. This is the one outside call in the request. The tenant id rides in notes/metadata and the provider ids are stored on `tenant_subscriptions` |
| Change plan | `POST .../change-plan` | upgrade: the provider charges the pro-rated difference now (Razorpay `schedule_change_at: now`, Stripe `always_invoice`), plan changes at once. Downgrade: stored as `pending_plan_key`, the worker tells the provider to switch the price from the next renewal (`billing.provider_change`), and the sweep applies it at the period end. Free: same as cancel |
| Cancel | `POST .../cancel` | `billing.manage` plus a fresh second-factor check. Sets `cancel_at_period_end`; the worker tells the provider. Two clicks are the screen's |
| Resume | `POST .../resume` | undoes a cancellation that has not happened |
| Settings | `PATCH .../settings` | overage mode and GSTIN, with the optional `version` check |
| Invoices | `GET .../invoices`, `.../invoices/[id]` | |

Every write checks `billing.manage` (owner by default and the Billing role; the Admin preset leaves it out), is refused during "view as this business", and writes an `audit_events` row in the same transaction. Upgrades are an extension of the "customer is waiting" exception: they charge the owner while they watch. Downgrade, cancel and resume go through the outbox.

## Webhooks

`POST /api/webhooks/billing/razorpay` and `/api/webhooks/billing/stripe`, five steps in order: raw body; signature (Razorpay: HMAC-SHA256 of the raw body in `X-Razorpay-Signature`; Stripe: `Stripe-Signature` `t=` and `v1=`, HMAC-SHA256 over `t.body`, 5-minute tolerance), constant-time, 401 with no detail; find the business (subscription id, then the tenant id in notes/metadata, then customer id) through `kalendr_resolve_subscription_tenant` / `kalendr_resolve_customer_tenant`; one transaction inserting `billing_events` (unique on provider and event id; a repeat returns `duplicate`) and an outbox row `billing.event` carrying only the row id; 200. A business that cannot be found, or a tenant id that fails the foreign key, is dropped with a 200. `billing_events.payload` is an allow-listed extract (ids, status, amount, currency, period times, plan ids); never card or UPI details, email, phone, name or the raw body.

The worker (`billing.event`) applies the event with the table-driven state machine in `src/server/billing/webhook-apply.ts`, creates the invoice for a successful charge, queues the owner email, and marks the row `applied`, `ignored` (unknown event type) or `invalid`.

## Dunning

`subscription.pending/halted`, `payment.failed`, `invoice.payment_failed` set `past_due` and email the owner each time. `past_due_since` is set on the first failure only and cleared by a charge; retrying never extends the grace period. Full service for 7 days (`effectivePlanKey`), Free from day 8, the owner-only banner while in grace. The sweep (`billing-sweep`, every 5 minutes, `src/worker/billing-jobs.ts`) then stores `free`, ends finished trials, applies pending downgrades and cancellations at the period end, and sends the trial-ending email once (keyed on the trial's end date, so an extended trial is reminded again).

## Invoices and GST

One `platform_invoices` row per successful charge, made in the worker transaction. Numbers are gapless (`kalendr_next_platform_invoice_number()`, worker role only): an advisory lock per payment and an existence check come first, so a repeated charge draws no number. **Assumption (needs your accountant):** a rupee charge is tax-inclusive, so `amount = round(total / 1.18)` and `GST = total - amount`; charges in other currencies carry no GST. Kalendr's GSTIN comes from `KALENDR_GSTIN` (optional) and the business's from its billing settings; both print only on rupee invoices. Money rows are never edited (a trigger refuses it); a correction is a new row.

## Needs your credentials

1. **Razorpay** account with Subscriptions and UPI Autopay enabled. Test-mode keys first. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`. Add a webhook to `https://<your host>/api/webhooks/billing/razorpay` for `subscription.activated`, `.charged`, `.pending`, `.halted`, `.paused`, `.resumed`, `.cancelled`, `.completed` and `payment.failed`; its secret is `RAZORPAY_WEBHOOK_SECRET`.
2. **Stripe** account. Set `STRIPE_SECRET_KEY`; webhook to `/api/webhooks/billing/stripe` for `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`; its secret is `STRIPE_WEBHOOK_SECRET`.
3. **Plans at each provider:** `RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... node scripts/billing-sync-plans.mjs razorpay` and `STRIPE_SECRET_KEY=... node scripts/billing-sync-plans.mjs stripe`. Copy the printed `RAZORPAY_PLAN_ID_*` / `STRIPE_PRICE_ID_*` lines into the environment (or the `plans.razorpay_plan_id` / `stripe_price_id` columns). The script refuses live keys without `--live`.
4. **`KALENDR_GSTIN`**: Kalendr's own GSTIN, once registered.
5. Prices and the GST assumption agreed with the owner and an accountant.

Until these are set, `checkoutAvailable` is false and the screen says so; nothing else breaks. Subscription events use `/api/webhooks/billing/razorpay` and `/api/webhooks/billing/stripe`; customer payments (feature 23) keep `/api/webhooks/stripe` and `/api/webhooks/razorpay/[publicId]`. `LIBRARIES_AND_APIS.md` names `*_PLATFORM_*` variables; this build uses the names above.

## Known limits

- Not tested against real Razorpay or Stripe: SDK calls (checkout, plan change, cancel, resume) are behind `SubscriptionProvider` and only a fake is exercised. Razorpay "resume" uses `cancelScheduledChanges`; confirm in test mode that it reverses a cycle-end cancellation.
- Webhooks are applied as they arrive; neither provider promises order, and an old event arriving late can briefly set an older status. Each patch only carries state the event states.
- A downgrade or cancellation is told to the provider by the worker, a few seconds after the owner confirms. The stored plan still changes only at the period end.
- A business stuck in `past_due` past grace is stored as `free` but its provider subscription is not cancelled by us; the provider's own retry rules end it.
- The owner email goes to `tenants.email`, the address given at sign-up.
- Overage is counted and shown; Kalendr does not yet bill the per-message overage amount.
- Locations and the paid feature gates are exported helpers until those features exist (see the table above).
- During "view as this business" the staff context is built by the admin lane and carries no `entitlements`, so plan limits are not applied to an operator acting with write access.
