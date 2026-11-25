import { randomUUID } from "node:crypto";

import { INVOICE_RENDER_EVENT } from "../../lib/invoicing-events";
import { fileStoreKey, getFileStore } from "../../server/file-store";
import { renderInvoicePdf, type PdfDocumentInput, type PdfLine } from "../../server/invoicing/pdf";
import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { sealBytes } from "../../server/keys/records";
import { loadDataKeys } from "../../server/keys/ring";
import type { EventHandler, TenantDb } from "../handlers/types";

type Row = Record<string, unknown>;

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const whole = (value: unknown): number => Number(value ?? 0);

function lineFrom(row: Row, taxed: { cgst: unknown; sgst: unknown; igst: unknown; total: unknown; taxable: unknown }): PdfLine {
  return {
    position: whole(row.position), description: String(row.description), sacCode: text(row.sac_code), quantity: whole(row.quantity), unitPriceMinor: whole(row.unit_price_minor),
    discountMinor: whole(row.discount_minor), rateBps: whole(row.rate_bps), taxableMinor: whole(taxed.taxable), cgstMinor: whole(taxed.cgst), sgstMinor: whole(taxed.sgst),
    igstMinor: whole(taxed.igst), totalMinor: whole(taxed.total),
  };
}

/** The business's own calendar date, as printed on the document. */
function printedDate(moment: unknown, zone: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: zone, day: "numeric", month: "short", year: "numeric" }).format(new Date(String(moment)));
}

async function loadInput(tenantDb: TenantDb, tenantId: string, payload: { invoiceId?: string; creditNoteId?: string }): Promise<PdfDocumentInput | null> {
  const [tenant] = await tenantDb<Row[]>`select timezone from tenants where id = ${tenantId}`;
  const zone = String(tenant?.timezone ?? "Asia/Kolkata");
  if (payload.creditNoteId) {
    const [note] = await tenantDb<Row[]>`select * from credit_notes where tenant_id = ${tenantId} and id = ${payload.creditNoteId}`;
    if (!note) return null;
    const [invoice] = await tenantDb<Row[]>`select * from invoices where tenant_id = ${tenantId} and id = ${String(note.invoice_id)}`;
    if (!invoice) return null;
    const lines = await tenantDb<Row[]>`
      select l.position, l.description, l.sac_code, l.quantity, l.unit_price_minor, l.discount_minor, l.rate_bps, cl.taxable_minor, cl.cgst_minor, cl.sgst_minor, cl.igst_minor, cl.total_minor
      from credit_note_lines cl join invoice_lines l on l.tenant_id = cl.tenant_id and l.id = cl.invoice_line_id
      where cl.tenant_id = ${tenantId} and cl.credit_note_id = ${payload.creditNoteId} order by l.position`;
    return {
      documentKind: "credit_note", number: String(note.number), issuedOn: printedDate(note.issued_at, zone), currency: String(invoice.currency),
      seller: { legalName: String(invoice.seller_legal_name), address: text(invoice.seller_address), gstin: text(invoice.seller_gstin), stateCode: text(invoice.seller_state_code) },
      buyer: { name: String(invoice.buyer_name), gstin: text(invoice.buyer_gstin), stateCode: text(invoice.buyer_state_code) },
      placeOfSupplyState: text(invoice.place_of_supply_state), supply: invoice.supply as PdfDocumentInput["supply"],
      lines: lines.map((row) => lineFrom(row, { taxable: row.taxable_minor, cgst: row.cgst_minor, sgst: row.sgst_minor, igst: row.igst_minor, total: row.total_minor })),
      totals: { taxableMinor: whole(note.taxable_minor), cgstMinor: whole(note.cgst_minor), sgstMinor: whole(note.sgst_minor), igstMinor: whole(note.igst_minor), totalMinor: whole(note.total_minor) },
      exemptionNote: text(invoice.exemption_note), againstNumber: String(invoice.number), reason: String(note.reason),
    };
  }
  if (!payload.invoiceId) return null;
  const [invoice] = await tenantDb<Row[]>`select * from invoices where tenant_id = ${tenantId} and id = ${payload.invoiceId}`;
  if (!invoice) return null;
  const lines = await tenantDb<Row[]>`select * from invoice_lines where tenant_id = ${tenantId} and invoice_id = ${payload.invoiceId} order by position`;
  return {
    documentKind: invoice.kind as PdfDocumentInput["documentKind"], number: String(invoice.number), issuedOn: printedDate(invoice.issued_at, zone), currency: String(invoice.currency),
    seller: { legalName: String(invoice.seller_legal_name), address: text(invoice.seller_address), gstin: text(invoice.seller_gstin), stateCode: text(invoice.seller_state_code) },
    buyer: { name: String(invoice.buyer_name), gstin: text(invoice.buyer_gstin), stateCode: text(invoice.buyer_state_code) },
    placeOfSupplyState: text(invoice.place_of_supply_state), supply: invoice.supply as PdfDocumentInput["supply"],
    lines: lines.map((row) => lineFrom(row, { taxable: row.taxable_minor, cgst: row.cgst_minor, sgst: row.sgst_minor, igst: row.igst_minor, total: row.total_minor })),
    totals: { taxableMinor: whole(invoice.taxable_minor), cgstMinor: whole(invoice.cgst_minor), sgstMinor: whole(invoice.sgst_minor), igstMinor: whole(invoice.igst_minor), totalMinor: whole(invoice.total_minor) },
    exemptionNote: text(invoice.exemption_note),
  };
}

/**
 * Renders an invoice or credit note to PDF, seals it with the business's data key and stores it (feature 24). Runs in the
 * worker so no request ever waits on it. Safe to run twice: the document row is unique, and the second run drops its copy.
 */
export function invoiceRenderHandler(): EventHandler {
  return async (tenantDb, event) => {
    const payload = event.payload as { invoiceId?: unknown; creditNoteId?: unknown } | null;
    const invoiceId = typeof payload?.invoiceId === "string" ? payload.invoiceId : undefined;
    const creditNoteId = typeof payload?.creditNoteId === "string" ? payload.creditNoteId : undefined;
    if (!invoiceId && !creditNoteId) return { outcome: "dead", code: "invalid_payload" };
    const done = invoiceId
      ? await tenantDb<Row[]>`select 1 from invoice_documents where tenant_id = ${event.tenantId} and invoice_id = ${invoiceId}`
      : await tenantDb<Row[]>`select 1 from invoice_documents where tenant_id = ${event.tenantId} and credit_note_id = ${creditNoteId ?? ""}`;
    if (done.length > 0) return "delivered";
    const input = await loadInput(tenantDb, event.tenantId, { invoiceId, creditNoteId });
    if (!input) return { outcome: "dead", code: "document_not_found" };
    const bytes = await renderInvoicePdf(input);
    await loadDataKeys(postgresDataKeyStore(tenantDb), event.tenantId, { forWrite: true });
    const key = fileStoreKey(event.tenantId, "invoice", randomUUID());
    await getFileStore().put(key, sealBytes(event.tenantId, bytes));
    const inserted = await tenantDb<Row[]>`
      insert into invoice_documents (tenant_id, invoice_id, credit_note_id, file_key, size_bytes)
      values (${event.tenantId}, ${invoiceId ?? null}, ${creditNoteId ?? null}, ${key}, ${bytes.length})
      on conflict do nothing returning id`;
    if (inserted.length === 0) await getFileStore().remove(key);
    return "delivered";
  };
}

export function invoiceHandlers(): [string, EventHandler][] {
  return [[INVOICE_RENDER_EVENT, invoiceRenderHandler()]];
}
