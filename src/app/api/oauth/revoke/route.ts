import { clientAddress, hitRateLimit } from "@/server/rate-limit";
import { revokeTokenValue } from "@/server/oauth/token-endpoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 7009. The answer is always 200, so it never says whether the value was real. */
export async function POST(request: Request): Promise<Response> {
  const limit = await hitRateLimit("oauth.token.ip", clientAddress(request.headers));
  if (limit.allowed) {
    const text = (await request.text()).slice(0, 2_000);
    const value = new URLSearchParams(text).get("token");
    if (value && value.length <= 200) await revokeTokenValue(value).catch(() => undefined);
  }
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
