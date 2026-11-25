import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";
import { z } from "zod";

import { setBreakGlassOwner } from "@/server/enterprise/domains";

const breakGlassSchema = z.object({ membershipId: z.string().trim().min(1).max(64) }).strict();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotImpersonating(context);
    return dataResponse(await setBreakGlassOwner(context, (await parseJsonBody(request, breakGlassSchema)).membershipId), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.org.break_glass", requestId);
  }
}
