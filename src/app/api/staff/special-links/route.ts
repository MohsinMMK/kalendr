import { z } from "zod";

import { createSpecialLinkInput } from "@/lib/special-links";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { createSpecialLink, listSpecialLinks } from "@/server/special-links";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const createBody = z.object({ serviceId: idSchema }).and(createSpecialLinkInput);

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const serviceId = idSchema.parse(new URL(request.url).searchParams.get("serviceId"));
    return dataResponse({ links: await listSpecialLinks(context, serviceId) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.special-links.list", requestId);
  }
}

/** The token comes back once, in this response. It is never stored in readable form. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { serviceId, ...input } = await parseJsonBody(request, createBody);
    return dataResponse(await createSpecialLink(context, serviceId, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.special-links.create", requestId);
  }
}
