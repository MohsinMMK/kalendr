import { z } from "zod";

import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { getOutstanding } from "@/server/invoicing/invoice";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.strictObject({ patientId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/) });

/** What one customer still owes across their standing invoices. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    return dataResponse(await getOutstanding(staff, parseQuery(request, querySchema).patientId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.invoices.outstanding", requestId);
  }
}
