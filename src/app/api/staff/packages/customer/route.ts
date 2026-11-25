import { z } from "zod";

import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { getCustomerOffers } from "@/server/offers/packages";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.strictObject({ patientId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/) });

/** One customer's packages (with each balance and its history) and memberships. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    return dataResponse(await getCustomerOffers(staff, parseQuery(request, querySchema).patientId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.packages.customer", requestId);
  }
}
