import { pushSubscriptionInputSchema } from "@/lib/staff-alerts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { pushPublicKey, pushUnsubscribeSchema, removePushSubscription, savePushSubscription } from "@/server/staff-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The public key a browser needs to subscribe. `publicKey` is null when push is not set up on this server. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await getStaffContext(request.headers);
    return dataResponse({ publicKey: pushPublicKey() });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.push.key", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, pushSubscriptionInputSchema, { maxBytes: 4_000 });
    return dataResponse(await savePushSubscription(context, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.push.subscribe", requestId);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, pushUnsubscribeSchema, { maxBytes: 2_000 });
    return dataResponse(await removePushSubscription(context, input.endpoint));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.push.unsubscribe", requestId);
  }
}
