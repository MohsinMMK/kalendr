# Invoices, receipts and GST (feature 24)

A business's own bills to its own customers. This is separate from Kalendr's invoices to businesses for the subscription (feature 14, `platform_invoices`), which use their own counter, table and the `KALENDR_GSTIN` environment variable.

## What was built

- **Tax engine** (`src/lib/gst.ts`, pure, tested to the paisa). CGST + SGST for a customer in the business's state and IGST for another, decided by place of supply (a buyer GSTIN's state first, then the state picked at the desk, then the business's own). Prices entered including tax carve the tax out of the price so the total never moves; prices before tax add tax on top. Rounding is per line, in paise; an odd paisa goes to the state half so the two halves always add to the tax. Union territories without a legislature say UTGST. Not registered: a receipt, no tax. Registered with nothing taxable: a bill of supply with the exemption wording. Healthcare is offered as exempt (Notification 12/2017, entry 74) with SAC 999312.
- **Tax settings** (`tax_settings`, `service_tax_rules`): registered or not, GSTIN (shape, state code and check character verified), legal name, address, state, prices include tax, a default treatment, and a rule per service. The owner confirms it ("checked with my accountant"); nothing is decided for them. Screen: Billing > Tax settings.
- **Invoices** (`invoices`, `invoice_lines`, `invoice_counters`, `credit_notes`, `credit_note_lines`). Only issued invoices exist; the screen's draft is a preview, so a number is never burned on something that was not issued. Numbers are gapless per business, financial year (April to March, read in the business's time zone) and series: `2026-27/0001` for invoices, `CN/2026-27/0001` for credit notes. The counter is bumped by one upsert inside the issuing transaction, after every check that can refuse, so a rollback gives the number back. The seller's details and the buyer's are copied onto the invoice when it is issued.
- **Immutability.** Triggers refuse any update or delete of an invoice, line, credit note, credit note line, document or link. A deferred trigger checks at commit that an invoice's header equals the sum of its lines (and the same for a credit note). Voiding an issued invoice is refused with a plain message; the fix is a credit note (whole lines, so the tax reversed is exactly what was charged) and, if needed, a new invoice. Whether an invoice is paid is worked out from the payments and credit notes each time (`unpaid`, `part_paid`, `paid`, `credited`, `refund_due`), never stored.
- **One ledger.** Desk payments (cash, UPI, card, bank, split, part) are the same `payments` rows as online ones. `payments.appointment_id` may now be empty for a sale with no visit (a package); such a row names the customer and the location and is included in the day-end totals. Day-end by method equals the payments by method (tested).
- **PDF.** `@react-pdf/renderer` 4.9.0 in the worker (`invoice.render`, queued in the issuing transaction), sealed with the business's data key into the file store. The engine is loaded on first use (`pdf.ts`), because its CommonJS build cannot be loaded by Node 26 and a worker that failed to load it would not start; it needs an ES module build, so the worker bundle (`scripts/build-jobs.mjs`, with a small plugin for the engine's built-in fonts) renders it and a worker started from source with `tsx` cannot. Noto Sans is embedded (the rupee sign lives in its Devanagari file). The public link `/api/public/invoices/<token>` serves it inline with `Cache-Control: no-store`; before the render lands it shows a "being prepared" page that refreshes itself. Tokens are 256-bit and stored as SHA-256 hashes; an unknown or expired link looks the same.
- **Export.** Billing > the menu: a month of invoices and credit notes as CSV (credit notes negative, spreadsheet formulas defanged), and the same month by tax rate.
- **Outstanding balances** on the customer profile and a notice when booking for someone who owes.
- Permissions: `invoices.issue` (new; issue, credit-note, export and tax settings view), with the existing `payments.collect`, `payments.refund`, `payments.close_day`, `payments.settings`. The spec's `billing.*` names were not added: `billing.manage` already means the Kalendr subscription.

## Migration

`0053_invoicing` (renumber to the reserved 0061 at merge). New tables above, `payments` gains `patient_id`, `location_id`, `invoice_id` and a nullable `appointment_id`, and one SECURITY DEFINER function `kalendr_resolve_invoice_link(text)` (ids only, callable by the web role).

## Known limits

- Visit invoices always treat the visit's price as what the customer pays (tax included), because the desk's "amount due" is the visit's price. The "prices before tax" setting applies to package and membership sales and to the pure engine.
- One line per invoice (the visit's service, with any member price or code shown as a discount). Extra lines and bulk invoicing are not built.
- A new invoice for a visit can be issued only after the earlier one is fully credited.
- The invoice link is copied by staff (as with payment links); sending it by WhatsApp or email needs an approved message template.
- The business logo (feature 13) is not printed yet; the layout has no logo slot until that feature lands.
- An erasure request keeps invoices (the business's tax record, like payments); the buyer name on them is not scrubbed.
- No e-invoicing (IRN) and no GSTR file export.

## Needs your credentials / decisions

- **An accountant must check the GST computations** (rounding, the place-of-supply rules, the default treatments and SAC codes offered per business type) before real use.
- `KALENDR_GSTIN` (Kalendr's own registration, for the subscription invoices).
- Each business enters its own GSTIN and legal details in Tax settings.
