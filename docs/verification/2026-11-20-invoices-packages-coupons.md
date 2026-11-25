# Invoices, receipts and GST (feature 24) and packages, memberships and coupons (feature 25): verification, 20 November 2026

Run on a scratch PostgreSQL **17** (port 5611; the repo's own script uses 18), the production build (`next start`) and the built-in test provider. No live Razorpay, Stripe, WhatsApp or GST account was used.

## Feature 24

| Done when | How it was shown | Result |
| --- | --- | --- |
| A GST-registered salon issues invoice `2026-27/0001` with CGST and SGST that add up to the paisa | `invoicing.integration.test.ts`: ₹1,180 inclusive becomes 1,000 + 90 + 90; an IGST case for a Maharashtra buyer GSTIN; `gst.test.ts` checks the sum for over 10,000 price, rate, inclusive/exclusive and in/out-of-state combinations; the e2e journey issues one on desktop and phone | Pass |
| A clinic's consultation invoice shows the exemption | Integration test: bill of supply, "Notification 12/2017, entry 74" on the invoice and in the PDF | Pass |
| Fifty invoices issued at once get fifty consecutive numbers | Integration test: 50 simultaneous issues, numbers `0001` to `0050` with no gap; a forced rollback after the number is drawn burns nothing; 31 March 23:59 and 1 April 00:00 India time land in different financial years, each starting at `0001` | Pass |
| A void attempt on an issued invoice is refused and a credit note works | The void route answers 409 with the credit-note instruction; triggers refuse update and delete; the credit note reverses exactly the lines' tax; a second one is refused; the audit rows hold no reason or name | Pass |
| The day-end total equals the sum of payments by method | Integration test: cash 300 + UPI 200 + card 70 (a visit-less sale) + bank 500 against `getDayEnd` and a direct sum | Pass |
| The PDF opens on a phone from the WhatsApp link | The `invoice.render` handler (run by the outbox drain under vitest) renders, seals and stores the PDF; the public route serves it inline with `no-store`, answers 202 "being prepared" before that and 404 for any dead link (both phone and desktop in the browser journey for the last two). The PDF was looked at as an image (the rupee sign prints). **No worker process has rendered one**: a worker started with `tsx` cannot load the PDF engine, and `dist/worker.mjs` does not build on the trunk for an older reason (see Follow-ups). The engine itself was bundled with the worker's esbuild settings and rendered a PDF from the bundle. Staff copy the link: sending it needs an approved WhatsApp template | Partly shown: handler and route pass; the production worker is blocked by the follow-ups below |

## Feature 25

| Done when | How it was shown | Result |
| --- | --- | --- |
| A customer buys a 10-session package, books with it, and the balance reads 9 with a ledger row explaining it | `offers.integration.test.ts`: sale writes one invoice, the payment and `+10`; a desk booking with the package writes `−1` for that booking; the customer view shows 9 and the ledger | Pass |
| Cancelling in time returns it to 10 | Staff cancel through the real status route writes `+1`; asking again gives nothing more; a late customer cancel keeps it spent; a visit whose service is changed after a credit or code was taken is refused (`discount_applied`) so the price cannot silently revert | Pass |
| Ten bookings at once against 1 remaining credit succeed exactly once | Ten simultaneous `use credit` calls on different visits, and ten simultaneous desk bookings on ten different times through the real booking path (serializable, with its retries): one wins, the rest are refused (`no_credits`, or "try again" when the retries run out), one ledger row; the database also refuses a direct row that would go below zero. The credit and coupon locks are real writes, because a waiter at serializable isolation keeps its old snapshot and a plain `FOR UPDATE` would not show it the winner's row | Pass |
| A coupon limited to 100 uses stops at 100 under load | 110 simultaneous redemptions of a 100-use code: exactly 100 succeed, 10 get `coupon_invalid`, 100 redemption rows. Through the real booking path a 6-use code with 12 simultaneous desk bookings never goes past 6 (losers get `coupon_invalid` or "try again") | Pass |
| A membership renewal webhook adds the month's credits once, even if delivered twice | A signed `subscription.renewed` through the real webhook route: second delivery is `duplicate`; a re-send under a new event id for the same period is ignored; one package, one `renewal` row, one invoice. A failed renewal gives 7 days' grace, then the sweep pauses benefits | Pass |

Also checked: a credited package sale can be refunded (it has no visit, so the refund route has its own branch) and the day's refunds include it; price order (member price, then code, then tax) with and without a stackable code; the public code check answers wrong, expired and other-service codes identically and is rate-limited; the booking page applies a code in the booking transaction and the invoice shows list price and discount; expiry writes off credits once and the 14-day and 3-day reminders go out once each; one business cannot see or change another's invoices, packages or ledger (service-level and through the web role with row-level security); money rows cannot be updated or deleted.

Screens: Billing (Invoices, Day end, Tax settings) and Offers (Packages, Memberships, Codes) were opened at 1366 px and 360 px, with an accessibility scan on the invoice sheet and on Offers (`e2e/invoicing.spec.ts`, desktop and phone). `e2e/offers-booking.spec.ts` books on the public page with a code on desktop and phone (wrong code refused with one sentence, right code shows the new price, the stored price is ₹800 and one redemption exists). The staff discount control, the customer packages section and the portal section were covered by component tests only and not opened in a browser. `pnpm check` is green. The database suites for the files this work touches (payments, day end, invoicing, offers, waitlist, series, privacy) pass individually on the scratch database; run together with other all-business worker tests on one shared database they interfere (a known property of those tests).

## Not shown

Anything against a live provider (subscriptions in particular), WhatsApp or email delivery of the invoice link and of the expiry reminders (templates not approved), the invoice PDF opened in a real phone's PDF viewer, an accountant's review of the GST computations. See "Known limits" in [../invoicing-and-gst.md](../invoicing-and-gst.md) and [../packages-and-coupons.md](../packages-and-coupons.md).

## Follow-ups (already true on the trunk at 6e7bd85, not caused by this work)

1. `scripts/build-jobs.mjs` fails: `src/worker/push.ts` imports the default export of `web-push` 4.0.0, which has none. Until that is fixed there is no `dist/worker.mjs`, so production gets no invoice PDFs, no payments worker and nothing else the worker does.
2. A worker started from source with `tsx` fails on `import "server-only"` (Next supplies that module; nothing outside Next does). Browser journeys that need a worker cannot run with `e2e/support/worker.ts`.
3. This work adds: the PDF engine cannot be loaded by `tsx` either (its CommonJS build is broken on Node 26). The worker bundle handles it (`scripts/build-jobs.mjs`).
