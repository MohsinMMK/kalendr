import { z } from "zod";

import { decideConsent, prepareConsent } from "@/server/oauth/authorize";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the consent screen shows: the app, the access it asks for, and where it will send the person afterwards. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const { consent } = await prepareConsent(context, Object.fromEntries(new URL(request.url).searchParams));
    return dataResponse({ consent });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.oauth.consent", requestId);
  }
}

const decision = z.object({ query: z.record(z.string(), z.string()), approve: z.boolean() }).strict();

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    assertNotImpersonating(context);
    const body = await parseJsonBody(request, decision);
    return dataResponse(await decideConsent(context, body.query, body.approve));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.oauth.decide", requestId);
  }
}
