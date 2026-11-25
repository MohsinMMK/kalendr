import { z } from "zod";

import { handoffActionSchema } from "@/lib/assistant-contracts";
import { actOnHandoff, listHandoffs, readHandoff } from "@/server/assistant/handoffs";
import { dataResponse, parseJsonBody, parseQuery, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** Without an id: the chats waiting for a person. With one: that chat's lines. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const { id } = parseQuery(request, z.object({ id: idSchema.optional() }));
    return dataResponse(id ? await readHandoff(context, id) : { handoffs: await listHandoffs(context) });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.assistant.handoffs.read", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const body = await parseJsonBody(request, handoffActionSchema.extend({ id: idSchema }));
    await actOnHandoff(context, body.id, body.action);
    return dataResponse({ ok: true });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.assistant.handoffs.act", requestId);
  }
}
