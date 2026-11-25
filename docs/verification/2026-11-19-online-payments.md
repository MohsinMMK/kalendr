# Online payments, deposits and policies (feature 23): verification, 19 November 2026

Run on a scratch PostgreSQL 17 (port 5561; the repo's own script uses 18), the built app, and the built-in test provider. No live Razorpay or Stripe account was used.

| Done when | How it was shown | Result |
| --- | --- | --- |
| A ₹800 service with a ₹200 deposit: the customer pays by UPI and the **webhook**, not the browser, confirms it | `e2e/online-payment.spec.ts` on desktop and phone: policy agreement, pay step with countdown, test checkout, "Confirming…", then Booked once the worker has handled the signed webhook. `payments.integration.test.ts` shows the booking stays `pending_payment` after the webhook is stored and only becomes `booked` when the worker applies it | Pass |
| Closing the checkout releases the slot after 10 minutes | Integration test: hold is 10 minutes, the slot leaves availability at once, `payment-hold-expiry` marks the booking `expired` and the slot is offered again | Pass |
| The same webhook delivered twice confirms once | Same event id gives `duplicate`; a different event id for the same payment still writes one ledger row (unique provider payment id) | Pass |
| A forged webhook is rejected | Wrong, missing and tampered signatures and an unknown address all raise the same 401 path; unit tests for each adapter | Pass |
| Cancelling inside the window refunds ₹200; outside it does not | Customer cancel through the manage link queues a policy refund, the worker pays it out and writes the ledger refund; with the visit 2 hours away nothing is queued | Pass |
| Two customers cannot both pay for the same slot | The second booking of a held slot is refused; a late payment after someone else took the time is refunded automatically | Pass |
| Changing the amount in the browser has no effect | The checkout request carries no amount; a webhook for another amount writes no ledger row and lands on the owner's mismatch list | Pass |

Also checked: money rows cannot be updated; another business sees none of the payment tables; test payments are left out of the day close; the Payments settings screen at 1366 px and 360 px. `pnpm check` is green; the database suite (21 files) passes on the scratch database.

Not shown: anything against a live provider, Razorpay Checkout.js under the production CSP, Stripe Connect onboarding. See "Needs your credentials" and "Known limits" in [../online-payments.md](../online-payments.md).
