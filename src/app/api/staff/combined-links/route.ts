import { z } from "zod";

import { createCombinedLinkInput } from "@/lib/special-links";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { createCombinedLink, listCombinedLinks } from "@/server/special-links";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const createBody = z.object({ serviceId: idSchema }).and(createCombinedLinkInput);

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const serviceId = idSchema.parse(new URL(request.url).searchParams.get("serviceId"));
    return dataResponse({ links: await listCombinedLinks(context, serviceId) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.combined-links.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { serviceId, ...input } = await parseJsonBody(request, createBody);
    return dataResponse(await createCombinedLink(context, serviceId, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.combined-links.create", requestId);
  }
}
