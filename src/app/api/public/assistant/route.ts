import { consumeStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";

import { assistantChatRequestSchema } from "@/lib/assistant-contracts";
import { publicAssistantConfig, webChat, webTranscript } from "@/server/assistant/web";
import { dataResponse, enforceLimit, parseJsonBody, parseQuery, routeErrorResponse } from "@/server/http";
import { clientAddress } from "@/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const readQuery = z.object({
  business: z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  token: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/).optional(),
});

/** Whether the chat is on for this business, and (with the visitor's token) the chat so far for a reloaded page. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "availability.ip");
    const query = parseQuery(request, readQuery);
    const config = await publicAssistantConfig(query.business);
    const transcript = config.enabled && query.token ? await webTranscript(query.business, query.token) : null;
    return dataResponse({ config, transcript });
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.assistant.read", requestId);
  }
}

/**
 * One message from a website visitor: text, a tapped Confirm, or the code from their text message.
 *
 * Anything that refuses it (the limits, an unknown business, a chat still answering, a repeated message) answers with the ordinary JSON
 * error before streaming starts. Every reply after that streams as AI SDK UI message chunks, fixed replies included (as one part).
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const body = await parseJsonBody(request, assistantChatRequestSchema, { maxBytes: 8 * 1_024 });
    const stream = await webChat(body, clientAddress(request.headers));
    return createUIMessageStreamResponse({
      stream,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Request-Id": requestId },
      // The model's words are sent only once the turn is settled, so a long turn is otherwise silent; a comment every 15 s keeps
      // proxies from closing the connection as idle. The page's reader skips comments.
      keepAliveMs: 15_000,
      // Keeps reading when the visitor closes the page, so the turn is still settled, saved and its lease let go.
      consumeSseStream: consumeStream,
    });
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.assistant.chat", requestId);
  }
}
