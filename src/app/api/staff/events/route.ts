import { ApiError } from "@/server/api-error";
import { routeErrorResponse } from "@/server/http";
import type { LiveSignal } from "@/server/live/hub";
import { subscribeToLiveChanges } from "@/server/live/listener";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Keeps proxies from closing a quiet stream. */
const HEARTBEAT_MS = 25_000;
/** The stream ends now and then so the browser reconnects and the sign-in is checked again. */
const STREAM_LIFETIME_MS = 10 * 60_000;

/**
 * Server-sent events for staff screens: "something changed for your business, refetch".
 * Only the signed-in business's changes are sent, and never any data.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  let unsubscribe: (() => void) | undefined;
  try {
    const context = await getStaffContext(request.headers);
    if (context.preview) throw new ApiError(400, "preview_only", "Live updates need a database.");
    const encoder = new TextEncoder();
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lifetime: ReturnType<typeof setTimeout> | undefined;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const queued: string[] = [];

    function send(chunk: string) {
      if (closed) return;
      if (!controllerRef) {
        queued.push(chunk);
        return;
      }
      try {
        controllerRef.enqueue(encoder.encode(chunk));
      } catch {
        close();
      }
    }

    function close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      unsubscribe?.();
      try {
        controllerRef?.close();
      } catch {
        // Already closed by the browser.
      }
    }

    // Subscribe before the response starts, so a failure to listen is still a normal error response.
    unsubscribe = await subscribeToLiveChanges(context.tenantId, (signal: LiveSignal) => {
      send(signal.type === "change" ? `event: change\ndata: ${JSON.stringify({ kind: signal.kind })}\n\n` : "event: resync\ndata: {}\n\n");
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        // A short, randomised retry spreads reconnects out after a deploy or a dropped network.
        send(`retry: ${3_000 + Math.floor(Math.random() * 4_000)}\nevent: ready\ndata: {}\n\n`);
        for (const chunk of queued.splice(0)) send(chunk);
        heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
        lifetime = setTimeout(close, STREAM_LIFETIME_MS);
        request.signal.addEventListener("abort", close, { once: true });
      },
      cancel: close,
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: unknown) {
    unsubscribe?.();
    return routeErrorResponse(error, "staff.events", requestId);
  }
}
