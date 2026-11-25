/**
 * Writes one numbered invoice with its lines (feature 24). Written against `Runner`, so the web server (desk visits, package
 * sales) and the worker (membership renewals) issue invoices through the same code. No "server-only": the worker imports this.
 */
import { sql } from "drizzle-orm";

import { DEFAULT_SERIES, placeOfSupply, taxInvoice, type TaxLineInput } from "../../lib/gst";
import { INVOICE_RENDER_EVENT } from "../../lib/invoicing-events";
import { ApiError } from "../api-error";
import { asString, type Runner } from "../workflows/runner";
import { drawNumber } from "./number";
import type { EffectiveTaxSettings, ServiceTax } from "./tax";

export interface SaleToInvoice {
  tenantId: string;
  patientId: string;
  locationId: string;
  source: "visit" | "package" | "membership";
  appointmentId?: string | null;
  description: string;
  /** What one unit costs as entered, before the discount. */
  unitPriceMinor: number;
  discountMinor?: number;
  quantity?: number;
  tax: ServiceTax;
  /** Visit prices are what the customer pays, so a visit invoice always carves its tax out of the price. */
  pricesIncludeTax: boolean;
  settings: EffectiveTaxSettings;
  buyer: { name: string; gstin?: string | null; stateCode?: string | null };
  issuedByUserId: string | null;
  issuedAt?: Date;
}

export interface IssuedInvoiceRef {
  id: string;
  number: string;
  totalMinor: number;
  currency: string;
}

/**
 * Writes the invoice and its line in the caller's transaction. The number is drawn last, after everything that can
 * refuse, so a refusal burns nothing. The row sums are re-checked by a deferred trigger at commit.
 */
export async function insertInvoice(run: Runner, sale: SaleToInvoice): Promise<IssuedInvoiceRef> {
  const { settings } = sale;
  const placing = settings.registered && settings.stateCode
    ? placeOfSupply({ supplierStateCode: settings.stateCode, buyerGstin: sale.buyer.gstin, buyerStateCode: sale.buyer.stateCode })
    : null;
  const line: TaxLineInput = {
    description: sale.description.slice(0, 200), sacCode: sale.tax.sacCode, quantity: sale.quantity ?? 1, unitPriceMinor: sale.unitPriceMinor,
    discountMinor: sale.discountMinor ?? 0, treatment: sale.tax.treatment, rateBps: sale.tax.rateBps,
  };
  const taxed = taxInvoice([line], { registered: settings.registered, pricesIncludeTax: sale.pricesIncludeTax, supply: placing?.supply ?? "intra" });
  const totals = taxed.totals;
  if (totals.totalMinor <= 0) throw new ApiError(409, "nothing_to_invoice", "There is nothing to charge here, so there is nothing to invoice.");
  const at = sale.issuedAt ?? new Date();
  const drawn = await drawNumber(run, sale.tenantId, DEFAULT_SERIES, at, settings.timezone);
  const taxedLine = taxed.lines[0]!;
  const exemption = taxedLine.appliedTreatment !== "taxable" ? sale.tax.exemptionNote : null;
  const charged = totals.cgstMinor + totals.sgstMinor + totals.igstMinor > 0;
  const [invoice] = await run(sql`
    insert into invoices (
      tenant_id, financial_year, series, sequence, number, patient_id, appointment_id, location_id, source, kind, currency, prices_include_tax,
      taxable_minor, cgst_minor, sgst_minor, igst_minor, total_minor, supply, place_of_supply_state,
      seller_gstin, seller_legal_name, seller_address, seller_state_code, buyer_name, buyer_gstin, buyer_state_code, exemption_note, issued_by_user_id, issued_at
    ) values (
      ${sale.tenantId}, ${drawn.financialYear}, ${drawn.series}, ${drawn.sequence}, ${drawn.number}, ${sale.patientId}, ${sale.appointmentId ?? null}, ${sale.locationId}, ${sale.source}, ${taxed.kind},
      ${settings.currency}, ${sale.pricesIncludeTax}, ${totals.taxableMinor}, ${totals.cgstMinor}, ${totals.sgstMinor}, ${totals.igstMinor}, ${totals.totalMinor},
      ${settings.registered && charged ? (placing?.supply ?? "intra") : "none"}, ${placing?.stateCode ?? null},
      ${settings.registered ? settings.gstin : null}, ${settings.legalName}, ${settings.address}, ${settings.stateCode},
      ${sale.buyer.name.slice(0, 200)}, ${sale.buyer.gstin ?? null}, ${placing?.stateCode ?? sale.buyer.stateCode ?? null}, ${exemption}, ${sale.issuedByUserId}, ${at.toISOString()}::timestamptz
    ) returning id`);
  const invoiceId = asString(invoice?.id);
  await run(sql`
    insert into invoice_lines (tenant_id, invoice_id, position, description, sac_code, quantity, unit_price_minor, discount_minor, treatment, rate_bps,
      taxable_minor, cgst_minor, sgst_minor, igst_minor, total_minor)
    values (${sale.tenantId}, ${invoiceId}, 1, ${taxedLine.description}, ${taxedLine.sacCode}, ${taxedLine.quantity}, ${taxedLine.unitPriceMinor}, ${taxedLine.discountMinor},
      ${taxedLine.appliedTreatment}, ${taxedLine.appliedRateBps}, ${taxedLine.taxableMinor}, ${taxedLine.cgstMinor}, ${taxedLine.sgstMinor}, ${taxedLine.igstMinor}, ${taxedLine.totalMinor})`);
  await run(sql`
    insert into audit_events (tenant_id, appointment_id, actor_user_id, actor_type, action, outcome, metadata)
    values (${sale.tenantId}, ${sale.appointmentId ?? null}, ${sale.issuedByUserId}, ${sale.issuedByUserId ? "staff" : "system"}, 'invoice.issued', 'success',
      ${JSON.stringify({ invoiceId, number: drawn.number, totalMinor: totals.totalMinor, currency: settings.currency, source: sale.source })}::text::jsonb)`);
  await run(sql`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${sale.tenantId}, 'invoice', ${invoiceId}, ${INVOICE_RENDER_EVENT}, ${JSON.stringify({ invoiceId })}::text::jsonb, ${`${INVOICE_RENDER_EVENT}:invoice:${invoiceId}`})
    on conflict (tenant_id, dedupe_key) do nothing`);
  return { id: invoiceId, number: drawn.number, totalMinor: totals.totalMinor, currency: settings.currency };
}
