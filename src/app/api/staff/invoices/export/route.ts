import { invoiceExportQuerySchema } from "@/lib/invoicing-contracts";
import { parseQuery, routeErrorResponse } from "@/server/http";
import { exportInvoicesCsv } from "@/server/invoicing/export";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A month of invoices and credit notes as CSV for the accountant, or the same month added up by tax rate. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const query = parseQuery(request, invoiceExportQuerySchema);
    const file = await exportInvoicesCsv(staff, query.month, query.kind);
    return new Response(file.body, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${file.filename}"`, "Cache-Control": "no-store" },
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.invoices.export", requestId);
  }
}
