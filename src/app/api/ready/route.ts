import { checkReadiness } from "@/server/readiness";

/**
 * Readiness: send traffic here only when the database answers and its migrations are
 * current. A load balancer reads the status code; the body names failing checks only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { ready, checks } = await checkReadiness();
  return Response.json(
    { status: ready ? "ready" : "not_ready", checks },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
