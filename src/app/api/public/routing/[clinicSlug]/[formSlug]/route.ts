import { z } from "zod";

import { slugSchema, submitAnswersSchema } from "@/lib/routing-forms";
import { ApiError } from "@/server/api-error";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getPublicRoutingForm, submitRoutingAnswers } from "@/server/routing-forms/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ clinicSlug: z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), formSlug: slugSchema });

interface Context { params: Promise<{ clinicSlug: string; formSlug: string }> }

async function readParams(context: Context) {
  const parsed = paramsSchema.safeParse(await context.params);
  // A malformed address and an unknown form look the same, so a visitor cannot tell which forms exist.
  if (!parsed.success) throw new ApiError(404, "routing_form_not_found", "This form is not available. Ask the business for a new link.");
  return parsed.data;
}

/** Headless use: a business's own website form can call this from the browser, so it answers cross-origin with no credentials. */
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };

function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
  return response;
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: cors });
}

/** The questions of a live form. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const { clinicSlug, formSlug } = await readParams(context);
    await enforceLimit(request, "routing_form.read.ip");
    return withCors(dataResponse(await getPublicRoutingForm(clinicSlug, formSlug)));
  } catch (error: unknown) {
    return withCors(routeErrorResponse(error, "public.routing.read", requestId));
  }
}

/**
 * Sends answers and gets back where to go: a booking page address (with the routing token, never the answers), another
 * website, or a message. It never says who was matched or why.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const { clinicSlug, formSlug } = await readParams(context);
    await enforceLimit(request, "routing_form.submit.ip");
    await enforceLimit(request, "routing_form.submit.form", `${clinicSlug}/${formSlug}`);
    const outcome = await submitRoutingAnswers(clinicSlug, formSlug, await parseJsonBody(request, submitAnswersSchema, { maxBytes: 32 * 1_024 }));
    return withCors(dataResponse(outcome));
  } catch (error: unknown) {
    return withCors(routeErrorResponse(error, "public.routing.submit", requestId));
  }
}
