import { dataResponse, routeErrorResponse } from "@/server/http";
import { removeTestData } from "@/server/onboarding/test-data";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Removes the owner's test booking and every sample appointment and customer, in one step. */
export async function DELETE(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await removeTestData(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.onboarding.remove_test_data", requestId);
  }
}
