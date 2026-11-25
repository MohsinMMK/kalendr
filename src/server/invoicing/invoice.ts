import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { withTenant, type KalendrTransaction as TenantTransaction } from "@/db/client";
import { auditEvents, creditNoteLines, creditNotes, outboxEvents } from "@/db/schema";
import { CREDIT_NOTE_SERIES, type TaxTreatment } from "@/lib/gst";
import type {
  CreditNoteInput, CreditNoteView, InvoiceList, InvoicePaymentView, InvoiceListQuery, InvoiceLineView, InvoicePayState, InvoiceSummary, InvoiceView, IssueInvoiceInput, OutstandingBalance,
} from "@/lib/invoicing-contracts";

import { ApiError } from "../api-error";
import { andLocation, assertLocationVisible, locationCondition } from "../location-scope";
import { claimKey, finishKey } from "../idempotent";
import { isPreviewMode } from "../preview-repository";
import { requirePermission, type StaffContext } from "../staff-context";
import { currentTraceParent } from "../tracing";
import { drawNumber } from "./number";
import { insertInvoice } from "./issue-core";
import { loadTaxSettings, serviceTax } from "./tax";
import { drizzleRunner } from "../workflows/runner";

import { INVOICE_RENDER_EVENT } from "@/lib/invoicing-events";

export { INVOICE_RENDER_EVENT };

const ISSUE_ROUTE = "staff.invoices.issue";
const CREDIT_ROUTE = "staff.invoices.credit";

function refusePreview(context: StaffContext): void {
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Invoices are not kept in the preview.");
}

const num = (value: unknown): number => Number(value ?? 0);

async function queueRender(transaction: TenantTransaction, tenantId: string, target: { invoiceId: string } | { creditNoteId: string }): Promise<void> {
  const [kind, id] = "invoiceId" in target ? ["invoice", target.invoiceId] : ["credit_note", target.creditNoteId];
  await transaction.insert(outboxEvents).values({
    tenantId, aggregateType: kind, aggregateId: id, eventType: INVOICE_RENDER_EVENT,
    payload: "invoiceId" in target ? { invoiceId: target.invoiceId } : { creditNoteId: target.creditNoteId },
    dedupeKey: `${INVOICE_RENDER_EVENT}:${kind}:${id}`, traceParent: currentTraceParent(),
  }).onConflictDoNothing();
}

// --- Reading ---------------------------------------------------------------------------------------------------

const paidSql = sql`(
  select coalesce(sum(p.amount_minor), 0) from payments p
  where p.tenant_id = i.tenant_id and (p.invoice_id = i.id or (i.appointment_id is not null and p.appointment_id = i.appointment_id))
)`;
const refundedSql = sql`(
  select coalesce(sum(r.amount_minor), 0) from payment_refunds r join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
  where r.tenant_id = i.tenant_id and (p.invoice_id = i.id or (i.appointment_id is not null and p.appointment_id = i.appointment_id))
)`;
const creditedSql = sql`(select coalesce(sum(c.total_minor), 0) from credit_notes c where c.tenant_id = i.tenant_id and c.invoice_id = i.id)`;
/** Another invoice for the same visit that still stands, which then carries the visit's payments. */
const siblingSql = sql`(
  exists (select 1 from invoices o where o.tenant_id = i.tenant_id and i.appointment_id is not null and o.appointment_id = i.appointment_id and o.id <> i.id
    and o.total_minor > (select coalesce(sum(c.total_minor), 0) from credit_notes c where c.tenant_id = o.tenant_id and c.invoice_id = o.id))
)`;

type SummaryRow = {
  id: string; number: string; kind: InvoiceSummary["kind"]; issued_at: Date; patient_id: string; buyer_name: string; appointment_id: string | null;
  source: InvoiceSummary["source"]; currency: string; total_minor: number; paid: number | string; refunded: number | string; credited: number | string; has_sibling: boolean;
};

/** Where an invoice stands, worked out from its payments and credit notes. Nothing about it is stored. */
export function payPosition(totalMinor: number, creditedMinor: number, paidMinor: number, refundedMinor: number, hasSibling: boolean): Pick<InvoiceSummary, "dueMinor" | "refundDueMinor" | "state"> {
  const net = paidMinor - refundedMinor;
  if (creditedMinor >= totalMinor) {
    // Fully corrected. If the customer had paid, the money still has to go back, unless a newer invoice for the same visit now holds it.
    const owed = hasSibling ? 0 : Math.max(0, net);
    return { dueMinor: 0, refundDueMinor: owed, state: owed > 0 ? "refund_due" : "credited" };
  }
  const standing = totalMinor - creditedMinor;
  const dueMinor = Math.max(0, standing - net);
  const refundDueMinor = Math.max(0, net - standing);
  const state: InvoicePayState = refundDueMinor > 0 ? "refund_due" : dueMinor === 0 ? "paid" : net > 0 ? "part_paid" : "unpaid";
  return { dueMinor, refundDueMinor, state };
}

function toSummary(row: SummaryRow): InvoiceSummary {
  const paid = num(row.paid) - num(row.refunded);
  return {
    id: row.id, number: row.number, kind: row.kind, issuedAt: new Date(row.issued_at).toISOString(), patientId: row.patient_id, buyerName: row.buyer_name,
    appointmentId: row.appointment_id, source: row.source, currency: row.currency, totalMinor: num(row.total_minor), creditedMinor: num(row.credited), paidMinor: paid,
    ...payPosition(num(row.total_minor), num(row.credited), num(row.paid), num(row.refunded), row.has_sibling),
  };
}

async function selectSummaries(transaction: TenantTransaction, tenantId: string, filter: SQL, tail: SQL): Promise<InvoiceSummary[]> {
  const rows = await transaction.execute<SummaryRow>(sql`
    select i.id, i.number, i.kind, i.issued_at, i.patient_id, i.buyer_name, i.appointment_id, i.source, i.currency, i.total_minor,
      ${paidSql} as paid, ${refundedSql} as refunded, ${creditedSql} as credited, ${siblingSql} as has_sibling
    from invoices i
    where i.tenant_id = ${tenantId} and ${filter}
    ${tail}
  `);
  return rows.map(toSummary);
}

type LineRow = {
  id: string; position: number; description: string; sac_code: string | null; quantity: number; unit_price_minor: number; discount_minor: number;
  treatment: TaxTreatment; rate_bps: number; taxable_minor: number; cgst_minor: number; sgst_minor: number; igst_minor: number; total_minor: number; credited_by: string | null;
};

/**
 * An invoice at a branch this person may not use reads as missing. Every invoice has a location (a package sale takes the
 * location it was sold at), so a limited person never sees one that has none. Exported for the link and credit paths.
 */
export async function assertInvoiceVisibleHere(transaction: TenantTransaction, context: StaffContext, invoiceId: string): Promise<void> {
  const [row] = await transaction.execute<{ location_id: string }>(sql`select location_id from invoices where tenant_id = ${context.tenantId} and id = ${invoiceId}`);
  if (row) assertLocationVisible(context, row.location_id, () => new ApiError(404, "invoice_not_found", "That invoice could not be found."));
}

export async function loadInvoiceView(transaction: TenantTransaction, tenantId: string, invoiceId: string): Promise<InvoiceView> {
  const [summary] = await selectSummaries(transaction, tenantId, sql`i.id = ${invoiceId}`, sql`limit 1`);
  if (!summary) throw new ApiError(404, "invoice_not_found", "That invoice could not be found.");
  const [header] = await transaction.execute<{
    financial_year: string; prices_include_tax: boolean; taxable_minor: number; cgst_minor: number; sgst_minor: number; igst_minor: number; supply: InvoiceView["supply"];
    place_of_supply_state: string | null; seller_gstin: string | null; seller_legal_name: string; seller_address: string | null; seller_state_code: string | null;
    buyer_gstin: string | null; buyer_state_code: string | null; exemption_note: string | null;
  }>(sql`select financial_year, prices_include_tax, taxable_minor, cgst_minor, sgst_minor, igst_minor, supply, place_of_supply_state, seller_gstin, seller_legal_name,
      seller_address, seller_state_code, buyer_gstin, buyer_state_code, exemption_note from invoices where tenant_id = ${tenantId} and id = ${invoiceId}`);
  const lineRows = await transaction.execute<LineRow>(sql`
    select l.id, l.position, l.description, l.sac_code, l.quantity, l.unit_price_minor, l.discount_minor, l.treatment, l.rate_bps,
      l.taxable_minor, l.cgst_minor, l.sgst_minor, l.igst_minor, l.total_minor,
      (select c.number from credit_note_lines cl join credit_notes c on c.tenant_id = cl.tenant_id and c.id = cl.credit_note_id
        where cl.tenant_id = l.tenant_id and cl.invoice_line_id = l.id) as credited_by
    from invoice_lines l where l.tenant_id = ${tenantId} and l.invoice_id = ${invoiceId} order by l.position
  `);
  const noteRows = await transaction.execute<{
    id: string; number: string; issued_at: Date; reason: string; taxable_minor: number; cgst_minor: number; sgst_minor: number; igst_minor: number; total_minor: number;
    line_ids: string[]; pdf_ready: boolean;
  }>(sql`
    select c.id, c.number, c.issued_at, c.reason, c.taxable_minor, c.cgst_minor, c.sgst_minor, c.igst_minor, c.total_minor,
      array(select cl.invoice_line_id from credit_note_lines cl where cl.tenant_id = c.tenant_id and cl.credit_note_id = c.id) as line_ids,
      exists (select 1 from invoice_documents d where d.tenant_id = c.tenant_id and d.credit_note_id = c.id) as pdf_ready
    from credit_notes c where c.tenant_id = ${tenantId} and c.invoice_id = ${invoiceId} order by c.issued_at, c.id
  `);
  const [document] = await transaction.execute<{ ready: boolean }>(sql`
    select exists (select 1 from invoice_documents where tenant_id = ${tenantId} and invoice_id = ${invoiceId}) as ready`);
  const paymentRows = await transaction.execute<{ id: string; method: InvoicePaymentView["method"]; amount_minor: number; created_at: Date; refunded: number | string; pending: number | string }>(sql`
    select p.id, p.method::text as method, p.amount_minor, p.created_at,
      (select coalesce(sum(r.amount_minor), 0) from payment_refunds r where r.tenant_id = p.tenant_id and r.payment_id = p.id) as refunded,
      (select coalesce(sum(q.amount_minor), 0) from refund_requests q where q.tenant_id = p.tenant_id and q.payment_id = p.id and q.status = 'pending') as pending
    from payments p join invoices i on i.tenant_id = p.tenant_id and i.id = ${invoiceId}
    where p.tenant_id = ${tenantId} and (p.invoice_id = i.id or (i.appointment_id is not null and p.appointment_id = i.appointment_id))
    order by p.created_at, p.id`);
  const lines: InvoiceLineView[] = lineRows.map((row) => ({
    id: row.id, position: num(row.position), description: row.description, sacCode: row.sac_code, quantity: num(row.quantity), unitPriceMinor: num(row.unit_price_minor),
    discountMinor: num(row.discount_minor), treatment: row.treatment, rateBps: num(row.rate_bps), taxableMinor: num(row.taxable_minor), cgstMinor: num(row.cgst_minor),
    sgstMinor: num(row.sgst_minor), igstMinor: num(row.igst_minor), totalMinor: num(row.total_minor), creditedBy: row.credited_by,
  }));
  const creditNoteViews: CreditNoteView[] = noteRows.map((row) => ({
    id: row.id, number: row.number, issuedAt: new Date(row.issued_at).toISOString(), reason: row.reason, taxableMinor: num(row.taxable_minor), cgstMinor: num(row.cgst_minor),
    sgstMinor: num(row.sgst_minor), igstMinor: num(row.igst_minor), totalMinor: num(row.total_minor), lineIds: row.line_ids, pdfReady: row.pdf_ready,
  }));
  return {
    ...summary,
    financialYear: header!.financial_year, pricesIncludeTax: header!.prices_include_tax, taxableMinor: num(header!.taxable_minor), cgstMinor: num(header!.cgst_minor),
    sgstMinor: num(header!.sgst_minor), igstMinor: num(header!.igst_minor), supply: header!.supply, placeOfSupplyState: header!.place_of_supply_state,
    sellerGstin: header!.seller_gstin, sellerLegalName: header!.seller_legal_name, sellerAddress: header!.seller_address, sellerStateCode: header!.seller_state_code,
    buyerGstin: header!.buyer_gstin, buyerStateCode: header!.buyer_state_code, exemptionNote: header!.exemption_note,
    lines, creditNotes: creditNoteViews, pdfReady: Boolean(document?.ready),
    payments: paymentRows.map((row) => ({
      id: row.id, method: row.method, amountMinor: num(row.amount_minor), at: new Date(row.created_at).toISOString(),
      refundableMinor: Math.max(0, num(row.amount_minor) - num(row.refunded) - num(row.pending)),
    })),
  };
}

export async function getInvoice(context: StaffContext, invoiceId: string): Promise<InvoiceView> {
  requirePermission(context, "payments.collect");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    await assertInvoiceVisibleHere(transaction, context, invoiceId);
    return loadInvoiceView(transaction, context.tenantId, invoiceId);
  });
}

export async function listInvoices(context: StaffContext, query: InvoiceListQuery): Promise<InvoiceList> {
  requirePermission(context, "payments.collect");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const filters: SQL[] = [sql`true`];
    const limit = locationCondition(context, sql`i.location_id`);
    if (limit) filters.push(limit);
    if (query.patientId) filters.push(sql`i.patient_id = ${query.patientId}`);
    if (query.appointmentId) filters.push(sql`i.appointment_id = ${query.appointmentId}`);
    if (query.month) {
      const [year, month] = query.month.split("-").map(Number) as [number, number];
      const start = `${year}-${String(month).padStart(2, "0")}-01`;
      const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const zone = (await loadTaxSettings(drizzleRunner(transaction), context.tenantId)).timezone;
      filters.push(sql`i.issued_at >= (${start}::date::timestamp at time zone ${zone}) and i.issued_at < (${next}::date::timestamp at time zone ${zone})`);
    }
    if (query.cursor) {
      const [issued, id] = query.cursor.split("|");
      if (!issued || !id || Number.isNaN(Date.parse(issued))) throw new ApiError(400, "bad_cursor", "That page marker is not valid.");
      filters.push(sql`(i.issued_at, i.id) < (${issued}::timestamptz, ${id})`);
    }
    // State filters are applied to the worked-out position, so ask for a little more than a page and cut it down.
    const rows = await selectSummaries(transaction, context.tenantId, sql.join(filters, sql` and `), sql`order by i.issued_at desc, i.id desc limit ${query.limit * 3 + 1}`);
    const wanted = rows.filter((row) => {
      if (query.state === "due") return row.dueMinor > 0 || row.refundDueMinor > 0;
      if (query.state === "paid") return row.state === "paid";
      if (query.state === "credited") return row.creditedMinor > 0;
      return true;
    });
    const page = wanted.slice(0, query.limit);
    const last = page.at(-1);
    return { invoices: page, nextCursor: wanted.length > query.limit && last ? `${last.issuedAt}|${last.id}` : null };
  });
}

/** What a customer still owes across their standing invoices. Shown on their profile and when booking again. */
export async function outstandingFor(transaction: TenantTransaction, tenantId: string, patientId: string, context?: StaffContext): Promise<OutstandingBalance> {
  // A limited person is owed-to only at their own branches; callers without a person (none today) see everything.
  const rows = await selectSummaries(transaction, tenantId, sql`i.patient_id = ${patientId} ${context ? andLocation(context, sql`i.location_id`) : sql``}`, sql`order by i.issued_at desc, i.id desc limit 200`);
  const owing = rows.filter((row) => row.dueMinor > 0);
  const [tenant] = await transaction.execute<{ currency: string }>(sql`select currency from tenants where id = ${tenantId}`);
  return {
    patientId, currency: tenant?.currency ?? "INR", dueMinor: owing.reduce((total, row) => total + row.dueMinor, 0),
    invoices: owing.map((row) => ({ id: row.id, number: row.number, dueMinor: row.dueMinor, issuedAt: row.issuedAt })),
  };
}

export async function getOutstanding(context: StaffContext, patientId: string): Promise<OutstandingBalance> {
  requirePermission(context, "payments.collect");
  refusePreview(context);
  return withTenant(context.tenantId, (transaction) => outstandingFor(transaction, context.tenantId, patientId, context));
}

// --- Issuing ---------------------------------------------------------------------------------------------------

const PAYABLE = ["booked", "checked_in", "completed", "no_show"];

/** Issues the numbered invoice or receipt for a visit, at the price the visit carries. */
export async function issueVisitInvoice(context: StaffContext, input: IssueInvoiceInput, idempotencyKey: string): Promise<InvoiceView> {
  requirePermission(context, "invoices.issue");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<InvoiceView>(transaction, context.tenantId, ISSUE_ROUTE, idempotencyKey, input);
    if ("replay" in claim) return claim.replay;
    const [visit] = await transaction.execute<{
      id: string; status: string; price_minor: number | null; service_id: string; service_name: string; patient_id: string; location_id: string;
      first_name: string; last_name: string;
    }>(sql`
      select a.id, a.status::text as status, a.price_minor, a.service_id, s.name as service_name, a.patient_id, a.location_id, p.first_name, p.last_name
      from appointments a
      join services s on s.tenant_id = a.tenant_id and s.id = a.service_id
      join patients p on p.tenant_id = a.tenant_id and p.id = a.patient_id
      where a.tenant_id = ${context.tenantId} and a.id = ${input.appointmentId}
      for update of a
    `);
    if (!visit) throw new ApiError(404, "appointment_not_found", "That visit could not be found.");
    assertLocationVisible(context, visit.location_id, () => new ApiError(404, "appointment_not_found", "That visit could not be found."));
    if (!PAYABLE.includes(visit.status)) throw new ApiError(409, "not_invoiceable", "Only a confirmed visit can be invoiced.");
    const [credit] = await transaction.execute<{ n: number }>(sql`select count(*)::int as n from appointment_discounts where tenant_id = ${context.tenantId} and appointment_id = ${visit.id} and kind = 'package'`);
    if (num(credit?.n) > 0) throw new ApiError(409, "paid_with_package", "This visit was paid with a package credit. The package sale has its own invoice.");
    if (!visit.price_minor || visit.price_minor <= 0) throw new ApiError(409, "no_price", "This visit has no price, so there is nothing to invoice. Set the price first.");
    // The visit's price is already net of a member price or code (feature 25). The invoice shows the list price and the discount, and tax is worked out after both.
    const [discounts] = await transaction.execute<{ total: number | string }>(sql`select coalesce(sum(amount_minor), 0) as total from appointment_discounts where tenant_id = ${context.tenantId} and appointment_id = ${visit.id}`);
    const discountMinor = num(discounts?.total);
    const standing = await selectSummaries(transaction, context.tenantId, sql`i.appointment_id = ${visit.id}`, sql`order by i.issued_at desc`);
    const open = standing.find((row) => row.state !== "credited");
    if (open) throw new ApiError(409, "invoice_exists", `This visit already has invoice ${open.number}. To change it, issue a credit note and then a new invoice.`);
    const settings = await loadTaxSettings(drizzleRunner(transaction), context.tenantId);
    if (input.buyerGstin && !settings.registered) throw new ApiError(409, "not_registered", "Turn on GST in the tax settings before adding a customer's GSTIN.");
    const tax = await serviceTax(drizzleRunner(transaction), context.tenantId, visit.service_id, settings);
    const issued = await insertInvoice(drizzleRunner(transaction), {
      tenantId: context.tenantId, patientId: visit.patient_id, locationId: visit.location_id, source: "visit", appointmentId: visit.id,
      description: visit.service_name, unitPriceMinor: visit.price_minor + discountMinor, discountMinor, tax, pricesIncludeTax: true, settings,
      buyer: { name: input.buyerName ?? `${visit.first_name} ${visit.last_name}`.trim(), gstin: input.buyerGstin ?? null, stateCode: input.buyerStateCode ?? null },
      issuedByUserId: context.userId,
    });
    const view = await loadInvoiceView(transaction, context.tenantId, issued.id);
    await finishKey(transaction, claim.claimId, view);
    return view;
  });
}

/** An issued invoice is never voided: the books keep every number. The only fix is a credit note. */
export async function voidInvoice(context: StaffContext, invoiceId: string): Promise<never> {
  requirePermission(context, "invoices.issue");
  const standing = await withTenant(context.tenantId, async (transaction) => {
    await assertInvoiceVisibleHere(transaction, context, invoiceId);
    const [row] = await transaction.execute<{ number: string }>(sql`select number from invoices where tenant_id = ${context.tenantId} and id = ${invoiceId}`);
    return row ?? null;
  });
  if (!standing) throw new ApiError(404, "invoice_not_found", "That invoice could not be found.");
  throw new ApiError(409, "invoice_issued", `Invoice ${standing.number} has been issued and can't be voided or edited. Issue a credit note to correct it, then a new invoice if needed.`);
}

/** Takes whole lines of an invoice back with a credit note. Money is refunded separately, through Payments. */
export async function issueCreditNote(context: StaffContext, invoiceId: string, input: CreditNoteInput, idempotencyKey: string): Promise<InvoiceView> {
  requirePermission(context, "payments.refund");
  requirePermission(context, "invoices.issue");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<InvoiceView>(transaction, context.tenantId, CREDIT_ROUTE, idempotencyKey, { invoiceId, ...input });
    if ("replay" in claim) return claim.replay;
    const [invoice] = await transaction.execute<{ id: string; appointment_id: string | null; currency: string }>(sql`
      select id, appointment_id, currency from invoices where tenant_id = ${context.tenantId} and id = ${invoiceId} for update`);
    if (!invoice) throw new ApiError(404, "invoice_not_found", "That invoice could not be found.");
    await assertInvoiceVisibleHere(transaction, context, invoiceId);
    const lines = await transaction.execute<LineRow>(sql`
      select l.id, l.position, l.description, l.sac_code, l.quantity, l.unit_price_minor, l.discount_minor, l.treatment, l.rate_bps,
        l.taxable_minor, l.cgst_minor, l.sgst_minor, l.igst_minor, l.total_minor,
        (select cl.credit_note_id from credit_note_lines cl where cl.tenant_id = l.tenant_id and cl.invoice_line_id = l.id) as credited_by
      from invoice_lines l where l.tenant_id = ${context.tenantId} and l.invoice_id = ${invoiceId} order by l.position`);
    const open = lines.filter((line) => line.credited_by === null);
    const chosen = input.lineIds ? open.filter((line) => input.lineIds!.includes(line.id)) : open;
    if (input.lineIds && input.lineIds.some((id) => !lines.some((line) => line.id === id))) throw new ApiError(404, "line_not_found", "One of those lines is not on this invoice.");
    if (chosen.length === 0) throw new ApiError(409, "already_credited", "This invoice has already been credited in full.");
    if (input.lineIds && chosen.length !== input.lineIds.length) throw new ApiError(409, "already_credited", "One of those lines has already been credited.");
    const sum = (pick: (line: LineRow) => number) => chosen.reduce((total, line) => total + pick(line), 0);
    const settings = await loadTaxSettings(drizzleRunner(transaction), context.tenantId);
    const drawn = await drawNumber(drizzleRunner(transaction), context.tenantId, CREDIT_NOTE_SERIES, new Date(), settings.timezone);
    const [note] = await transaction.insert(creditNotes).values({
      tenantId: context.tenantId, invoiceId, financialYear: drawn.financialYear, series: drawn.series, sequence: drawn.sequence, number: drawn.number, reason: input.reason,
      taxableMinor: sum((line) => num(line.taxable_minor)), cgstMinor: sum((line) => num(line.cgst_minor)), sgstMinor: sum((line) => num(line.sgst_minor)),
      igstMinor: sum((line) => num(line.igst_minor)), totalMinor: sum((line) => num(line.total_minor)), issuedByUserId: context.userId,
    }).returning({ id: creditNotes.id });
    await transaction.insert(creditNoteLines).values(chosen.map((line) => ({
      tenantId: context.tenantId, creditNoteId: note!.id, invoiceLineId: line.id, taxableMinor: num(line.taxable_minor), cgstMinor: num(line.cgst_minor),
      sgstMinor: num(line.sgst_minor), igstMinor: num(line.igst_minor), totalMinor: num(line.total_minor),
    })));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, appointmentId: invoice.appointment_id, actorUserId: context.userId, actorType: "staff", action: "credit_note.issued", outcome: "success",
      // The reason is free text, so it stays out of the activity log.
      metadata: { invoiceId, creditNoteId: note!.id, number: drawn.number, totalMinor: sum((line) => num(line.total_minor)), currency: invoice.currency },
    });
    if (chosen.length === open.length) {
      // A package sale taken back in full leaves nothing paid for: its unused credits go with it, or they stay bookable for free.
      const [held] = await transaction.execute<{ id: string; remaining: number }>(sql`
        select pack.id, (select coalesce(sum(credit."change"), 0)::int from customer_credits as credit
          where credit.tenant_id = pack.tenant_id and credit.customer_package_id = pack.id) as remaining
        from customer_packages as pack where pack.tenant_id = ${context.tenantId} and pack.invoice_id = ${invoiceId} for update`);
      if (held && num(held.remaining) > 0) {
        await transaction.execute(sql`
          insert into customer_credits (tenant_id, customer_package_id, "change", kind, reason, actor_user_id)
          values (${context.tenantId}, ${held.id}, ${-num(held.remaining)}, 'adjust', 'Package sale credited in full', ${context.userId})`);
      }
    }
    await queueRender(transaction, context.tenantId, { creditNoteId: note!.id });
    const view = await loadInvoiceView(transaction, context.tenantId, invoiceId);
    await finishKey(transaction, claim.claimId, view);
    return view;
  });
}
