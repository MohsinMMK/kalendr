import { z } from "zod";

import { packageInputSchema } from "@/lib/offers-contracts";
import { ApiError } from "@/server/api-error";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { savePackage } from "@/server/offers/packages";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/** Edits a package. Packages already sold keep what they were sold as. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError(404, "package_not_found", "That package could not be found.");
    return dataResponse(await savePackage(staff, id.data, await parseJsonBody(request, packageInputSchema, { maxBytes: 4_000 })));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.packages.update", requestId);
  }
}
