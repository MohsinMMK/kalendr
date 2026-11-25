import { z } from "zod";

import { openResponseSchema, slugSchema } from "@/lib/routing-forms";
import { ApiError } from "@/server/api-error";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { openRoutingForm } from "@/server/routing-forms/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ clinicSlug: z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), formSlug: slugSchema });

/** Starts a visit, the funnel's first step. The page keeps the returned token and sends it back with the answers. */
export async function POST(request: Request, context: { params: Promise<{ clinicSlug: string; formSlug: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const parsed = paramsSchema.safeParse(await context.params);
    if (!parsed.success) throw new ApiError(404, "routing_form_not_found", "This form is not available. Ask the business for a new link.");
    await enforceLimit(request, "routing_form.open.ip");
    await parseJsonBody(request, openResponseSchema, { maxBytes: 1_024 });
    return dataResponse(await openRoutingForm(parsed.data.clinicSlug, parsed.data.formSlug), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.routing.open", requestId);
  }
}
