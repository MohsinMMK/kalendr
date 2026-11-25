import { dataResponse, enforceLimit, parseJsonBody, routeErrorResponse } from "@/server/http";
import { sha256 } from "@/server/crypto";
import { doorJoinInputSchema, getJoinView, joinFromDoor } from "@/server/queue-door";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface JoinRouteContext {
  params: Promise<{ token: string }>;
}

/** What the page behind the door QR code shows. No customer names. */
export async function GET(request: Request, context: JoinRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "queue_read.ip");
    return dataResponse(await getJoinView((await context.params).token));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.queue.join_view", requestId);
  }
}

/** Someone at the door gives a first name and phone number and gets a token. */
export async function POST(request: Request, context: JoinRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const { token } = await context.params;
    await enforceLimit(request, "queue_join.ip");
    await enforceLimit(request, "queue_join.link", sha256(token));
    const input = await parseJsonBody(request, doorJoinInputSchema, { maxBytes: 2_048 });
    return dataResponse(await joinFromDoor(token, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.queue.join", requestId);
  }
}
