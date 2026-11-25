import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents } from "@/db/schema";

import { ApiError } from "../api-error";
import { isPreviewMode } from "../preview-repository";
import { andLocation } from "../location-scope";
import { requirePermission, type StaffContext } from "../staff-context";
import { drizzleRunner } from "../workflows/runner";
import { loadTaxSettings } from "./tax";

/** A cell that starts with = + - @ would run as a formula in a spreadsheet, so it is written as text. */
export function csvCell(value: string | number | { amount: string } | null): string {
  if (value === null) return "";
  // An amount we formatted ourselves ("-1180.00") must stay a number in the spreadsheet.
  if (typeof value === "object") return value.amount;
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const rupees = (minor: number): { amount: string } => ({ amount: (minor / 100).toFixed(2) });

function monthBounds(month: string): { from: string; to: string } {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return { from: `${year}-${String(number).padStart(2, "0")}-01`, to: number === 12 ? `${year + 1}-01-01` : `${year}-${String(number + 1).padStart(2, "0")}-01` };
}

type Row = {
  kind: string; number: string; against: string | null; issued_at: Date; buyer_name: string; buyer_gstin: string | null; place: string | null; supply: string;
  sac: string | null; description: string; qty: number; treatment: string; rate_bps: number; taxable: number; cgst: number; sgst: number; igst: number; total: number; sign: number;
  seller_gstin: string | null; currency: string;
};

/**
 * Invoices and credit notes issued in a month, one row per line, in a layout an accountant can import. Credit notes carry
 * negative amounts, so the column totals are the month's net. `gst-summary` is the same month added up by tax rate.
 */
export async function exportInvoicesCsv(context: StaffContext, month: string, kind: "documents" | "gst-summary"): Promise<{ filename: string; body: string }> {
  requirePermission(context, "invoices.issue");
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Exports are not available in the preview.");
  const { from, to } = monthBounds(month);
  return withTenant(context.tenantId, async (transaction) => {
    const zone = (await loadTaxSettings(drizzleRunner(transaction), context.tenantId)).timezone;
    const rows = await transaction.execute<Row>(sql`
      select * from (
        select 'Invoice' as kind, i.number, null::text as against, i.issued_at, i.buyer_name, i.buyer_gstin, i.place_of_supply_state as place, i.supply,
          l.sac_code as sac, l.description, l.quantity as qty, l.treatment, l.rate_bps, l.taxable_minor as taxable, l.cgst_minor as cgst, l.sgst_minor as sgst,
          l.igst_minor as igst, l.total_minor as total, 1 as sign, i.seller_gstin, i.currency, l.position
        from invoices i join invoice_lines l on l.tenant_id = i.tenant_id and l.invoice_id = i.id
        where i.tenant_id = ${context.tenantId} ${andLocation(context, sql`i.location_id`)} and i.issued_at >= (${from}::date::timestamp at time zone ${zone}) and i.issued_at < (${to}::date::timestamp at time zone ${zone})
        union all
        select 'Credit note', c.number, i.number, c.issued_at, i.buyer_name, i.buyer_gstin, i.place_of_supply_state, i.supply,
          l.sac_code, l.description, l.quantity, l.treatment, l.rate_bps, cl.taxable_minor, cl.cgst_minor, cl.sgst_minor, cl.igst_minor, cl.total_minor, -1, i.seller_gstin, i.currency, l.position
        from credit_notes c
        join invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id
        join credit_note_lines cl on cl.tenant_id = c.tenant_id and cl.credit_note_id = c.id
        join invoice_lines l on l.tenant_id = cl.tenant_id and l.id = cl.invoice_line_id
        where c.tenant_id = ${context.tenantId} ${andLocation(context, sql`i.location_id`)} and c.issued_at >= (${from}::date::timestamp at time zone ${zone}) and c.issued_at < (${to}::date::timestamp at time zone ${zone})
      ) documents order by issued_at, number, position
    `);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "invoices.exported", outcome: "success", metadata: { month, kind, rows: rows.length },
    });
    if (kind === "gst-summary") {
      const byRate = new Map<string, { rate: number; treatment: string; taxable: number; cgst: number; sgst: number; igst: number; total: number; count: number }>();
      for (const row of rows) {
        const key = `${row.treatment}:${row.rate_bps}`;
        const entry = byRate.get(key) ?? { rate: Number(row.rate_bps), treatment: row.treatment, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0, count: 0 };
        const sign = Number(row.sign);
        entry.taxable += sign * Number(row.taxable); entry.cgst += sign * Number(row.cgst); entry.sgst += sign * Number(row.sgst); entry.igst += sign * Number(row.igst);
        entry.total += sign * Number(row.total); entry.count += 1;
        byRate.set(key, entry);
      }
      const lines = [["Treatment", "Rate %", "Lines", "Taxable value", "CGST", "SGST/UTGST", "IGST", "Total"].join(",")];
      for (const entry of [...byRate.values()].sort((a, b) => a.rate - b.rate || a.treatment.localeCompare(b.treatment))) {
        lines.push([entry.treatment, (entry.rate / 100).toFixed(2), entry.count, rupees(entry.taxable), rupees(entry.cgst), rupees(entry.sgst), rupees(entry.igst), rupees(entry.total)].map(csvCell).join(","));
      }
      const sum = (pick: (entry: { taxable: number; cgst: number; sgst: number; igst: number; total: number }) => number) => rupees([...byRate.values()].reduce((total, entry) => total + pick(entry), 0));
      lines.push(["All", "", rows.length, sum((e) => e.taxable), sum((e) => e.cgst), sum((e) => e.sgst), sum((e) => e.igst), sum((e) => e.total)].map(csvCell).join(","));
      return { filename: `gst-summary-${month}.csv`, body: `${lines.join("\r\n")}\r\n` };
    }
    const header = ["Document", "Number", "Against invoice", "Date", "Customer", "Customer GSTIN", "Place of supply", "Supply", "HSN/SAC", "Description", "Qty", "Treatment", "Rate %",
      "Taxable value", "CGST", "SGST/UTGST", "IGST", "Total", "Seller GSTIN", "Currency"];
    const lines = [header.join(",")];
    for (const row of rows) {
      const sign = Number(row.sign);
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(row.issued_at));
      lines.push([row.kind, row.number, row.against, date, row.buyer_name, row.buyer_gstin, row.place, row.supply, row.sac, row.description, row.qty, row.treatment,
        (Number(row.rate_bps) / 100).toFixed(2), rupees(sign * Number(row.taxable)), rupees(sign * Number(row.cgst)), rupees(sign * Number(row.sgst)), rupees(sign * Number(row.igst)),
        rupees(sign * Number(row.total)), row.seller_gstin, row.currency].map(csvCell).join(","));
    }
    return { filename: `invoices-${month}.csv`, body: `${lines.join("\r\n")}\r\n` };
  });
}
