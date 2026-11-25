# Plans and subscription billing: verification, 19 November 2026

Backend and worker only (screens are a separate lane). No real provider was called; no real message was sent.

**How:** a scratch PostgreSQL 18 on 127.0.0.1:5609 (database `kalendr_e2e_billbe`, all migrations including 0043), runtime, worker and owner roles, `KALENDR_PREVIEW_MODE=false`.

**Tested and passing**

- Unit (no database): provider chooser, GST maths, usage alerts, the message gate including "a protected message is never blocked on any plan at any usage", signature checks for both providers (good, bad, old timestamp, rotation), what is stored from events (no email, VPA, phone, card), the webhook state machine as a table, entitlement refusals naming the unlocking plan, the dunning timeline (full service on day 6, Free on day 8), the new permission.
- `src/server/billing/billing-flow.integration.test.ts`: a trial business checks out (one provider call per Idempotency-Key), a verified Razorpay `subscription.activated` through the real route handler makes it Starter and active, once however often it is delivered; bad signature stores nothing; a charge makes one invoice (42,288 + 7,612 GST = 49,900); a failed renewal sets past_due, one start of grace, two emails; the banner for the owner and not an admin on day 6, Free on day 8; the sweep; trial-ending email once and again after an extension; unknown business dropped with 200; Stripe route signature and timestamp; a tenant with no subscription row gets a trial.
- `billing-enforcement.integration.test.ts`: a fourth staff calendar on Starter refused with `plan_limit` naming Growth (through `createStaffPractitioner`); two creates at once cannot both pass; read-only calendars after a downgrade; Free's 51st booking; business B cannot read or change business A's rows in four tables; events and invoices cannot be edited or deleted; invoice numbers gapless under concurrent issues and one payment invoiced once.
- `src/worker/billing-delivery.integration.test.ts`: N WhatsApp messages sent through `providerSink` give a counter of N; a duplicate and a retry do not double count; alerts once each; Free sends a reminder by email and stops a review request with `plan_channel_locked`; with no email the confirmation is still sent and logged; marketing stops past the allowance or is billed by choice.

**Not tested:** any real Razorpay or Stripe call (checkout, change, cancel, resume, real webhook bodies and ordering), email through Resend, the screens, a browser run, `pnpm check` as a whole.
