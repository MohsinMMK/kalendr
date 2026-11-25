import { dataResponse, routeErrorResponse } from "@/server/http";
import { getQueueScreen } from "@/server/queue-screens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the waiting-room screen shows: token numbers and who is calling. No names. */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getQueueScreen((await context.params).token));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.queue.screen", requestId);
  }
}
