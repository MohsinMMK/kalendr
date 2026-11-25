import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { customerEnter, customerHeartbeat, customerWait, getVisitStatus } from "@/server/video/visit-service";
import { visitActionSchema } from "@/lib/video-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tokenSchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/);

interface Context { params: Promise<{ token: string }> }

async function readToken(context: Context): Promise<string> {
  const parsed = tokenSchema.safeParse((await context.params).token);
  if (!parsed.success) throw new ApiError(404, "appointment_not_found", "That link isn't valid. Check the message you were sent, or phone the business.");
  return parsed.data;
}

/** Where the visit stands: open yet, who is here, whether staff have let the customer in. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = await readToken(context);
    await enforceLimit(request, "visit.token", token);
    return dataResponse(await getVisitStatus(token));
  } catch (error) {
    return routeErrorResponse(error, "public.visit.read", requestId);
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const token = await readToken(context);
    await enforceLimit(request, "visit.token", token);
    const input = await parseJsonBody(request, visitActionSchema);
    if (input.action === "wait") return dataResponse(await customerWait(token));
    if (input.action === "heartbeat") return dataResponse(await customerHeartbeat(token));
    return dataResponse(await customerEnter(token));
  } catch (error) {
    return routeErrorResponse(error, "public.visit.act", requestId);
  }
}
