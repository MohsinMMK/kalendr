import { mergeInputSchema } from "@/lib/customer-contracts";
import { mergeCustomers, suggestDuplicates } from "@/server/customers/merge";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pairs that look like the same person. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await suggestDuplicates(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.duplicates", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await mergeCustomers(context, await parseJsonBody(request, mergeInputSchema), getIdempotencyKey(request)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.merge", requestId);
  }
}
