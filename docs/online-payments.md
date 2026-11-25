# Online payments, deposits and policies (feature 23)

Customers can pay a deposit or the full price when they book. Each business connects **its own**
payment account, so money goes straight to the business and Kalendr never holds it. Online payments
are written to the same ledger as desk payments (`payments`, `payment_refunds`); there is no second one.

Shared shapes live in `src/lib/payments.ts` (zod schemas, types, the pure rules). Read that file first.

## How a payment flows

1. The customer picks a time and fills in the form. If the service takes payment (`services.payment_mode`
   is `deposit` or `full`) **and** the business has an active payment account, the booking is created
   in state `pending_payment`, its reservations are `held` for 10 minutes, and the response carries
   `payment: BookingPaymentRequired`. Nothing is sent to the customer or staff yet.
2. The browser calls `POST /api/public/bookings/pay`. The server works out the amount from the service
   (never from the browser), asks the provider for an order (the one allowed outside call inside a
   request) and returns a `CheckoutSession`.
3. The browser opens the provider's checkout (Razorpay Checkout.js, Stripe's hosted page, or the built-in
   test checkout). The browser's "success" only moves to a **Confirming…** screen that polls
   `POST /api/public/bookings/pay/status`.
4. The provider calls the webhook. The route checks the signature over the raw body, records the event
   once (unique on provider event id) with an outbox row, and returns 200. The worker's
   `payment.captured` handler checks amount and currency against the order, writes the `payments` row,
   moves the appointment to `booked` (or `requested`), turns the hold into `confirmed`, and queues the
   normal confirmation message. **Only the webhook confirms a payment.**
5. The `payment-hold-expiry` job runs every minute: unpaid holds past their time are released and the
   appointment is `expired`. A payment that arrives later re-confirms the time if it is still free;
   if someone else took it, the payment is refunded automatically.

## Routes

All bodies and responses are `{ data: … }` / `{ error: { code, message, fieldErrors? } }` like every other route.

### Customer (no sign-in)

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/public/appointments` (existing) | as before | adds `payment?: BookingPaymentRequired` when `status` is `pending_payment` |
| `POST /api/public/bookings/pay` | `StartPaymentInput` | `CheckoutSession` |
| `POST /api/public/bookings/pay/status` | `StartPaymentInput` | `PaymentStatus` |
| `GET /api/public/clinics?…` (existing catalog) | | each service gains `payment: PublicServicePayment \| null` |
| `POST /api/public/bookings/test-checkout` | `{ orderId, outcome: "paid" \| "failed" }` | Only exists outside production. The built-in test checkout posts here; the server sends a **signed** webhook to its own webhook route, exactly as a provider would. |

The built-in test checkout page is `/pay/test/[orderId]`.

### Staff (need a sign-in and the named permission)

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /api/staff/payment-settings` | `payments.settings` | `PaymentSettingsView` |
| `PUT /api/staff/payment-account` | `payments.settings` + recent second factor | `PaymentAccountInput`; checks the keys with one harmless provider call before saving; returns `PaymentAccountView` |
| `DELETE /api/staff/payment-account` | `payments.settings` + recent second factor | disconnect |
| `PUT /api/staff/payment-policy` | `payments.settings` | `PaymentPolicyInput` (with `version`); returns `PaymentPolicy` |
| `PUT /api/staff/services/[id]/payment` | `payments.settings` | `ServicePaymentInput`; returns the saved `ServicePayment` |
| `GET /api/staff/payments/mismatches` | `payments.settings` | `MismatchView[]` (open first) |
| `POST /api/staff/payments/mismatches/[id]/resolve` | `payments.settings` | `resolveMismatchSchema` |
| `POST /api/staff/appointments/[id]/payment-link` | `payments.collect` | `PaymentLinkInput` → `PaymentLinkResult` |
| `GET/POST /api/staff/appointments/[id]/payments` (existing) | `payments.collect` | `VisitPayments`; online payments carry `provider`, `isTest`; refunds of online payments return 202 with a pending refund |

## Tables (migration `0042_online_payments`)

All have forced row-level security on `app.tenant_id` and composite `(tenant_id, id)` keys.

| Table | What it holds |
| --- | --- |
| `tenant_payment_accounts` | One per business: provider, `test` or `live`, key id, the secret and webhook secret **sealed** with the business's data key (`payments.secret`, `payments.webhook-secret`), `key_version` (re-encrypted by the storage job), and `public_id`, the unguessable part of the webhook address |
| `tenant_payment_policies` | The three plain settings: free-cancel hours, rule after the window (`no_refund`, `keep_deposit`), no-show rule (`deposit`, `everything`) |
| `payment_orders` | One checkout asked of the provider. The only mutable part of a payment (`created`, `paid`, `failed`, `expired`). One open order per booking |
| `payments`, `payment_refunds` (existing, extended) | The ledger. New columns: `provider`, `provider_payment_id`, `order_id`, `is_test`; `request_id`, `provider_refund_id`. Unique on the provider's payment and refund ids, so a repeat can never insert twice. Still insert-only (the existing trigger refuses updates) |
| `refund_requests` | A refund asked for and not yet paid out (`pending`, `done`, `failed`). Counts against what can still be refunded, so two asks cannot add up to more than the payment |
| `payment_events` | Every webhook, once per provider event id. Only ids, amounts and statuses are kept: provider payloads carry the payer's email and phone |
| `payment_mismatches` | What the nightly check or a strange webhook found; the owner clears them |

New columns: `services.payment_mode` / `deposit_minor`; `appointments.payment_terms` (the rules agreed) and `payment_terms_text` (the exact words shown); appointment statuses `pending_payment` and `expired`; payment method `other`.

Definer functions (ids only): `kalendr_resolve_payment_account(public_id)`, `kalendr_resolve_stripe_account(account)` (web app), `kalendr_payment_tenants(job)` (worker only; revoked from the web role in the release script and the test scripts). `kalendr_storage_tenants` is redefined to include payment keys.

## Code map

| Area | Where |
| --- | --- |
| Shared shapes and pure rules | `src/lib/payments.ts` |
| Adapters (`razorpay`, `stripe`, `fake`) | `src/server/payments/` (`provider types`, `http`, `signature`) |
| Account, policy, service pricing, mismatches | `src/server/payments/accounts.ts` |
| Checkout, status, pay page | `src/server/payments/checkout.ts` |
| Webhook intake | `src/server/payments/webhook.ts`, routes under `src/app/api/webhooks/{razorpay,fake}/[publicId]` and `stripe` |
| Ledger helpers and the refund request | `src/server/payments/ledger.ts` |
| **Cancel / no-show seam** | `src/server/payments/cancellation.ts` |
| Worker | `src/worker/payments/` (`event`, `capture`, `refund`, `reconcile`, `jobs`) |
| Booking hold | `createAppointmentTransaction` in `src/server/appointment-repository.ts` (one quote call, `pending_payment`, reservations `held`) |

## The seam for cancel and reschedule policy (feature 42)

```ts
import { applyPaymentPolicy } from "@/server/payments/cancellation";
const outcome = await applyPaymentPolicy(drizzleRunner(transaction), { tenantId, appointmentId, event: "cancel" | "no_show", actorUserId });
// { action: "none" | "refunded" | "kept", refundMinor, keptMinor, currency }
```

It uses the terms stored on the appointment when it was booked (never today's policy), queues the refund for the worker, and calls no provider, so it is safe in any request transaction. It is already called from `recordMutation` for the cancel and no-show actions, so today's flows follow the policy. Calling it twice does nothing the second time. `decideRefund` in `src/lib/payments.ts` is the pure rule, if feature 42 needs to show "you would get ₹X back" before the customer confirms.

## Money rules this keeps

- Money rows are inserted, never edited. A refund is a `refund_requests` row, then a `payment_refunds` row once the provider paid it out.
- No card, UPI or bank detail is ever stored: only provider ids, amounts and statuses.
- Every webhook is verified over the raw body with a constant-time compare, and recorded once per provider event id; the amount and currency are checked against the order before the ledger is written.
- The only provider call inside a request is creating the order (and trying keys when an account is connected). Everything else (refunds, the nightly check) goes through the outbox and the worker.

## Test mode

Each account is `test` or `live` (Razorpay says so by the key prefix). Test payments carry `is_test`, are labelled in the visit's payments screen, and are left out of the day close. The built-in `fake` provider exists only outside production (and for browser tests on localhost, `KALENDR_E2E_TEST_CHECKOUT=true`); its checkout posts a signed body to the real webhook route.

## Needs your credentials

Nothing here was run against a live provider; the adapters are tested against the providers' documented wire formats with a fake `fetch`.

- **Razorpay** (India): each business needs its own account. Create a test-mode account at razorpay.com, then in the dashboard: copy the **Key Id** and **Key Secret** (Settings, API Keys), add a webhook pointing at the address shown in Settings, Payments, with the events `payment.captured`, `payment.failed` and `refund.processed`, and note its secret. Make sure payments are **auto-captured** (Settings, Payment Capture), because only `payment.captured` confirms a booking.
- **Stripe Connect** (outside India): a Stripe platform account with Connect enabled. Set `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_CONNECT_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET` (all three, or none), and add a Connect webhook (events from connected accounts) to `/api/webhooks/stripe` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `refund.created` and `refund.updated`.

## Known limits

- **Not run against live providers.** Razorpay Checkout.js under the production Content-Security-Policy, Stripe Connect onboarding and real webhook delivery need the accounts above.
- **Connect with Stripe is built but untried against Stripe**: the start and callback routes (`/api/staff/payment-account/stripe/connect` and `/callback`) need a real platform account, and the callback address must be added to the platform's allowed redirect URIs.
- **Sending a pay link by message is not built.** Staff get a link to copy (`POST /api/staff/appointments/[id]/payment-link`); asking the server to send it answers `send_unavailable`. It needs an approved message template, which belongs to the messaging work.
- **The customer is not messaged when a late payment is refunded** because the time was taken. The money goes back automatically and a staff alert is raised; the customer's message needs a template too.
- **Reschedules carry no price difference.** The payment stays attached to the booking and nothing is asked for or refunded when a visit moves; a change of length that changes the price is not handled. The pure rule (`decideRefund`) is ready for feature 42.
- **A payment link or checkout for a booking whose account was disconnected cannot be completed**, and disconnecting while a customer is paying strands that payment until the owner reconnects the same keys (the nightly check lists it).
- **Stripe shows the method as "Other"** in the ledger: the session event does not say how the customer paid.
- **Refund policy for fully-prepaid services:** there is no separate deposit, so "refund minus the deposit" refunds nothing after the window (the same as "no refund").
- **The nightly check** looks at the previous UTC day and runs at 21:00 UTC; it reads at most 1,000 Razorpay payments or 1,000 Stripe payment intents for the day.
- **The policy treats a cancel by staff like a cancel by the customer** (time before the visit), and a payment taken through a pay link on a booking that has no stored terms is never refunded by rule. In both cases staff can always refund more by hand from the visit's payments screen.
- **A refund the provider rejects** is marked failed and raises a "Something needs a person" alert; the request is not retried by itself.
- **Waitlist** does not yet pick up a time released by an unpaid hold.
