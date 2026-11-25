import { resolveMismatchSchema } from "@/lib/payments";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { resolveMismatch } from "@/server/payments/accounts";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Clears one item once the owner has looked at it. The note is for the owner's own memory and is not kept. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    await parseJsonBody(request, resolveMismatchSchema, { maxBytes: 1_000 });
    await resolveMismatch(staff, (await context.params).id);
    return dataResponse({ resolved: true });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.payment_mismatches.resolve", requestId);
  }
}
