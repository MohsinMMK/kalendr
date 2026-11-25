/**
 * Kalendr's own tax invoices to businesses (feature 14). One row per successful provider charge, made by the worker
 * inside the same transaction that applies the charge. No "server-only": the worker imports this.
 *
 * GST: charges in rupees are tax-inclusive (the plan price is what the customer pays), so for INR the invoice splits
 * the total as amount = round(total / 1.18) and GST = total - amount. Charges in other currencies carry no GST.
 * Numbers come from `kalendr_next_platform_invoice_number()`, which only the worker role may call.
 */
import type postgres from "postgres";

import { invoiceAmounts } from "../../lib/billing-rules";
import type { InvoiceToIssue } from "./webhook-apply";

type TenantDb = postgres.TransactionSql;

export interface IssuedInvoice {
  issued: boolean;
  invoiceNumber: string | null;
}

export interface InvoiceParties {
  /** Kalendr's GSTIN from `KALENDR_GSTIN`, printed only on rupee invoices. */
  kalendrGstin: string | null;
  buyerGstin: string | null;
}

/**
 * Idempotent per provider payment id. The payment's advisory lock is taken first, so two deliveries of the same charge
 * queue up behind each other; the second finds the invoice and draws no number. Drawing a number and then hitting
 * the unique index would burn a number and leave a gap, so the existence check always comes first.
 */
export async function issueInvoice(tenantDb: TenantDb, tenantId: string, provider: "razorpay" | "stripe", charge: InvoiceToIssue, parties: InvoiceParties): Promise<IssuedInvoice> {
  // One lock per payment, so two deliveries of the same charge queue up here and the second finds the invoice.
  await tenantDb`select pg_advisory_xact_lock(hashtext(${`invoice:${provider}:${charge.providerPaymentId}`}))`;
  const existing = await tenantDb<{ invoice_number: string }[]>`
    select invoice_number from platform_invoices where provider = ${provider} and provider_payment_id = ${charge.providerPaymentId}
  `;
  if (existing[0]) return { issued: false, invoiceNumber: existing[0].invoice_number };

  const amounts = invoiceAmounts(charge.currency, charge.amountMinor);
  const [next] = await tenantDb<{ sequence: number; invoice_number: string }[]>`select sequence, invoice_number from kalendr_next_platform_invoice_number()`;
  if (!next) throw new Error("Invoice number function returned no row");
  const inIndia = charge.currency.toUpperCase() === "INR";
  await tenantDb`
    insert into platform_invoices (
      tenant_id, invoice_number, sequence, provider, provider_payment_id, plan_key, currency,
      amount_minor, gst_rate_bps, gst_minor, total_minor, kalendr_gstin, buyer_gstin, period_start, period_end
    ) values (
      ${tenantId}, ${next.invoice_number}, ${next.sequence}, ${provider}, ${charge.providerPaymentId}, ${charge.planKey}, ${charge.currency.toUpperCase()},
      ${amounts.amountMinor}, ${amounts.gstRateBps}, ${amounts.gstMinor}, ${amounts.totalMinor},
      ${inIndia ? parties.kalendrGstin : null}, ${inIndia ? parties.buyerGstin : null}, ${charge.periodStart}, ${charge.periodEnd}
    )
  `;
  return { issued: true, invoiceNumber: next.invoice_number };
}
