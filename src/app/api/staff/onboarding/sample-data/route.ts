import { dataResponse, routeErrorResponse } from "@/server/http";
import { addSampleData } from "@/server/onboarding/test-data";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Adds a week of clearly labelled sample appointments and customers. Nothing is sent to anyone. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await addSampleData(context), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.onboarding.sample_data", requestId);
  }
}
