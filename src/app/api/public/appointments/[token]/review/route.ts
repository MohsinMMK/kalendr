import { requireLiveManageLink } from "@/server/patient-step-up";
import { z } from "zod";

import { reviewInputSchema } from "@/lib/reviews";
import { ApiError } from "@/server/api-error";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getReviewStateByToken, saveReviewByToken } from "@/server/reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tokenSchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/);

interface ReviewRouteContext {
  params: Promise<{ token: string }>;
}

/** Whether the customer can review this appointment now, and their review if they wrote one. */
export async function GET(_request: Request, context: ReviewRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getReviewStateByToken(await readToken(context)));
  } catch (error) {
    return routeErrorResponse(error, "public.appointment.review.read", requestId);
  }
}

/** Writes or replaces the customer's review. Only after a finished appointment, for 60 days. */
export async function PUT(request: Request, context: ReviewRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = await readToken(context);
    await enforceLimit(request, "manage_link.token", token);
    const { rating, comment } = await parseJsonBody(request, reviewInputSchema);
    return dataResponse(await saveReviewByToken(token, { rating, comment: comment ?? undefined }));
  } catch (error) {
    return routeErrorResponse(error, "public.appointment.review.save", requestId);
  }
}

async function readToken(context: ReviewRouteContext): Promise<string> {
  const { token } = await context.params;
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  await requireLiveManageLink(parsed.data);
  return parsed.data;
}
