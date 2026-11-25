# Packages, memberships and coupons (feature 25)

## What was built

- **Packages** (`packages`, `customer_packages`, `customer_credits`). Selling one at the desk is one transaction: an invoice (feature 24), the payments taken (split across methods; part payment leaves the rest owing) and one `+N` ledger row. What was bought is copied onto the customer's package, so editing the package later changes nothing they own.
- **The credit ledger is the balance.** `customer_credits` only grows (a trigger refuses edits and deletes). Using a credit locks the package row, then checks the balance, then writes `−1` with a unique key per booking; a database trigger also refuses any row that would take a package below zero. Cancelling returns the credit (`+1`, unique per booking) when the customer cancels inside the free-cancel window of the payment policy (24 hours by default) or when the business cancels, declines or removes the booking; a late customer cancel and a no-show keep it spent. The return runs next to `applyPaymentPolicy` in the booking mutation. A nightly job writes an `expiry` row for credits left on a package that ran out of time and queues the 14-day and 3-day "You have 3 sessions left on …, valid until 30 March." message once each (`package.expiry_reminder`; WhatsApp needs that template approved). Manual adjustments need `payments.refund` and a reason.
- **Memberships** (`membership_plans`, `customer_memberships`, `membership_events`). A plan gives credits each month, a member discount on chosen services, or both. Renewals add that period's credits once: the provider's event id is unique, a period not later than the one already applied is ignored, and each period's credit package has a unique (membership, period). A failed renewal starts 7 days of grace (benefits on), then the hourly sweep pauses benefits. Memberships started at the desk are billed by hand (`manual`): the desk records each month's payment. Provider events (`subscription.renewed`, `payment_failed`, `ended`) arrive through the existing signed webhook route and the `payment.event` handler; the built-in test provider emits them, and the Razorpay and Stripe adapters map their documented subscription events.
- **Coupons** (`coupons`, `coupon_redemptions`, `appointment_discounts`). Percent or fixed; total limit, per-customer limit, dates, services, first visit only, and "can be used with a member price". The check runs inside the booking transaction under a lock on the coupon row, so a 100-use code stops at 100 under load (tested with 110 at once). A redemption is released (not deleted) when its booking is cancelled or its payment hold expires. The public check `/api/public/coupons/validate` is rate-limited (20 per 10 minutes per IP) and answers every failure identically; the rules that depend on who is booking are enforced at booking and never revealed to a customer.
- **Price order** (fixed, tested): list price, then the member price, then the coupon on what is left, then tax on the invoice. One discount per booking unless the code is stackable. The booking's `price_minor` is the net price, so the deposit, the pay link, the balance and the day-end "owed" all agree; the discounts are in `appointment_discounts` and the invoice shows the list price and the discount.
- **Hooks into booking.** The public booking form takes a `couponCode`; the staff booking takes a `couponCode` or a `customerPackageId`; an existing visit can be paid with a credit ("Use a package credit"). Package credits are applied at the desk only: a public booking cannot spend someone's credits on name, email and phone alone.
- The customer profile and the portal (`/api/portal/offers`) show packages, balances, expiry and memberships.

## Migration

`0054_packages_coupons` (renumber to the reserved 0062 at merge): the tables above, RLS on all of them, the immutability and balance triggers, and `kalendr_offers_tenants(text)` (ids only, worker role only; added to the REVOKE lists in `scripts/migrate.mjs`, `scripts/e2e-database.mjs` and `scripts/verify-postgres18.sh`).

## Known limits

- Buying a package or a membership online (a customer paying through the provider) is not built; the desk sells them. The portal shows balances only.
- Real Razorpay and Stripe subscriptions are not created from Kalendr: the adapters' subscription webhook mapping is written from the providers' documentation and has not run against a live account. Until then use desk-billed memberships. There is no screen yet to attach an existing provider subscription to a customer: a provider-billed membership can only be linked in the database.
- Reports (feature 26) are not built yet; the data for "packages sold", "credits outstanding" and "coupon use" is queryable now (`PackageView.sold`, `creditsOutstanding`, `CouponView.used`).
- A package sale's invoice uses the business default tax treatment.
- Money given back for a credited package or membership sale is recorded from the invoice ("Give the money back"); it is the desk's own refund row, paid out by hand.
- A visit with a credit, code or member price cannot have its service changed (the price would revert and the credit stay spent); cancel and book the other service.

## Needs your credentials

- A live Razorpay (Subscriptions) and Stripe account to exercise provider-billed memberships.
- WhatsApp template approval for `package.expiry_reminder`.
