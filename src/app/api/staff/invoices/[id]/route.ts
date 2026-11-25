import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getInvoice } from "@/server/invoicing/invoice";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const invoiceIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    const parsed = invoiceIdSchema.safeParse((await context.params).id);
    if (!parsed.success) throw new ApiError(404, "invoice_not_found", "That invoice could not be found.");
    return dataResponse(await getInvoice(staff, parsed.data));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.invoices.get", requestId);
  }
}
