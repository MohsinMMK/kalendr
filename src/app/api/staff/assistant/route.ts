import { consumeStream, createUIMessageStreamResponse } from "ai";

import { copilotConfirmSchema, copilotRequestSchema } from "@/lib/assistant-contracts";
import { copilotConfirm, copilotStream } from "@/server/assistant/copilot";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A question to the staff copilot. It looks things up and proposes; it never changes anything.
 *
 * Anything that can refuse (sign-in, the plan, the rate limit, a full chat, the monthly allowance, no model) answers with the ordinary
 * JSON error before streaming starts. Once it has started, the answer streams as AI SDK UI message chunks.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const turn = await copilotStream(context, await parseJsonBody(request, copilotRequestSchema, { maxBytes: 8 * 1_024 }), request.signal);
    return createUIMessageStreamResponse({
      stream: turn.stream,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId },
      // Keeps reading when the page goes away, so a stopped answer is wound up (usage counted) rather than left hanging.
      consumeSseStream: consumeStream,
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.assistant.copilot", requestId);
  }
}

/** The staff member pressed Confirm on a suggestion. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await copilotConfirm(context, await parseJsonBody(request, copilotConfirmSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.assistant.confirm", requestId);
  }
}
