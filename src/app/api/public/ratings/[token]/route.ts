import { z } from "zod";

import { ratingPageInputSchema } from "@/lib/rating-page";
import { ApiError } from "@/server/api-error";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getRatingState, saveRating } from "@/server/ratings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tokenSchema = z.string().min(20).max(200).regex(/^[A-Za-z0-9_-]+$/);

interface RouteContext { params: Promise<{ token: string }> }

async function readToken(context: RouteContext): Promise<string> {
  const parsed = tokenSchema.safeParse((await context.params).token);
  if (!parsed.success) throw new ApiError(404, "rating_not_found", "This rating link does not work. Ask the business for a new one.");
  return parsed.data;
}

/** The ask behind a rating link, and the answer if there is one. The link itself is the proof: 256 bits, stored only as a hash. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = await readToken(context);
    await enforceLimit(request, "rating_link.ip");
    return dataResponse(await getRatingState(token));
  } catch (error) {
    return routeErrorResponse(error, "public.rating.read", requestId);
  }
}

/** One tap records the stars; a second call can add a comment and choose who sees it, for a week. */
export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = await readToken(context);
    await enforceLimit(request, "rating_link.ip");
    await enforceLimit(request, "rating_link.token", token);
    return dataResponse(await saveRating(token, await parseJsonBody(request, ratingPageInputSchema)));
  } catch (error) {
    return routeErrorResponse(error, "public.rating.save", requestId);
  }
}
