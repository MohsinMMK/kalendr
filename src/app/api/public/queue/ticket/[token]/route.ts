import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getQueueTicket, setTicketNotify, ticketNotifyInputSchema } from "@/server/queue-screens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TicketRouteContext {
  params: Promise<{ token: string }>;
}

/** The customer's place in today's queue. */
export async function GET(_request: Request, context: TicketRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getQueueTicket((await context.params).token));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.queue.ticket", requestId);
  }
}

/** Turns "Tell me when I'm next" on or off. Nothing else can be changed from this link. */
export async function PATCH(request: Request, context: TicketRouteContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const { token } = await context.params;
    const input = await parseJsonBody(request, ticketNotifyInputSchema, { maxBytes: 200 });
    return dataResponse(await setTicketNotify(token, input));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.queue.notify", requestId);
  }
}
