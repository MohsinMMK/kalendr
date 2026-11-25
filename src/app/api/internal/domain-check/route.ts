import { timingSafeEqual } from "node:crypto";

import { env } from "@/server/env";
import { isServedDomain } from "@/server/domains/service";
import { enforceLimit, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const answer = (status: 200 | 403 | 404): Response => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

function tokenMatches(supplied: string | null, expected: string): boolean {
  if (!supplied) return false;
  const first = Buffer.from(supplied);
  const second = Buffer.from(expected);
  return first.length === second.length && timingSafeEqual(first, second);
}

/**
 * Asked by the certificate host (Caddy's `on_demand_tls ask`, or the equivalent) before it issues a certificate:
 * 200 only for an address that is live for some business, 404 for everything else. This is what stops anyone from
 * pointing a random domain at Kalendr and getting a certificate. No body, so nothing is revealed about who owns what.
 * When KALENDR_DOMAIN_CHECK_TOKEN is set the caller must send it as ?token=, so only your certificate host can ask.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const url = new URL(request.url);
    const required = env().KALENDR_DOMAIN_CHECK_TOKEN;
    if (required && !tokenMatches(url.searchParams.get("token"), required)) return answer(403);
    await enforceLimit(request, "domain_check.ip");
    const domain = url.searchParams.get("domain");
    return answer(domain && (await isServedDomain(domain)) ? 200 : 404);
  } catch (error: unknown) {
    return routeErrorResponse(error, "internal.domain_check", requestId);
  }
}
