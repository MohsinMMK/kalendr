import { pushSubscriptionInputSchema } from "@/lib/staff-alerts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { requirePatientAccount } from "@/server/patient-auth";
import { removePortalPush, savePortalPush } from "@/server/portal-push";
import { pushPublicKey, pushUnsubscribeSchema } from "@/server/staff-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The public key a browser needs to subscribe. Null when push is not set up on this server. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await requirePatientAccount(request.headers);
    return dataResponse({ publicKey: pushPublicKey() });
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.push.key", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const account = await requirePatientAccount(request.headers);
    const input = await parseJsonBody(request, pushSubscriptionInputSchema, { maxBytes: 4_000 });
    return dataResponse(await savePortalPush(account, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.push.subscribe", requestId);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const account = await requirePatientAccount(request.headers);
    const input = await parseJsonBody(request, pushUnsubscribeSchema, { maxBytes: 2_000 });
    return dataResponse(await removePortalPush(account, input.endpoint));
  } catch (error: unknown) {
    return routeErrorResponse(error, "portal.push.unsubscribe", requestId);
  }
}
