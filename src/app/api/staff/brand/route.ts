import { brandUpdateSchema, loadStaffBrand, saveBrand } from "@/server/brand";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The business's accent colour, corner style and badge setting, with the logo and cover addresses. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await loadStaffBrand(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.brand.read", requestId);
  }
}

/** Saves the whole look at once. Saving the same values again changes nothing. Hiding the badge needs a plan that includes it. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await saveBrand(context, await parseJsonBody(request, brandUpdateSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.brand.save", requestId);
  }
}
