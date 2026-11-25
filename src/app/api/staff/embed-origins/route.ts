import { z } from "zod";

import { embedOriginInputSchema } from "@/lib/domain-rules";
import { addEmbedOrigin, listEmbedOrigins } from "@/server/domains/service";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The websites allowed to show this business's booking widget. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse({ origins: await listEmbedOrigins(await getStaffContext(request.headers)) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.embed_origins.list", requestId);
  }
}

/** Allows one more website. Adding one that is already on the list changes nothing. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, z.strictObject(embedOriginInputSchema.shape));
    return dataResponse(await addEmbedOrigin(context, input.origin), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.embed_origins.add", requestId);
  }
}
