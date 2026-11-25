import { replyToInput } from "@/lib/reply-to";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { applyReplyTo, clearReplyTo, getReplyTo } from "@/server/reply-to";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getReplyTo(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.reply-to.get", requestId);
  }
}

/** `send` emails a code to the new address; `verify` stores it once the code is right. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await applyReplyTo(context, await parseJsonBody(request, replyToInput)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.reply-to.apply", requestId);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await clearReplyTo(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.reply-to.clear", requestId);
  }
}
