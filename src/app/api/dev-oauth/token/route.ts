import { devOAuthEnabled, readDevGrant } from "@/server/dev-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The development stand-in's token endpoint: the code is the access token. */
export async function POST(request: Request): Promise<Response> {
  if (!devOAuthEnabled()) return new Response("Not found", { status: 404 });
  const form = new URLSearchParams(await request.text());
  const code = form.get("code");
  if (!code || !readDevGrant(code)) return Response.json({ error: "invalid_grant" }, { status: 400 });
  return Response.json({ access_token: code, token_type: "Bearer", expires_in: 600, scope: "openid email profile" }, { headers: { "cache-control": "no-store" } });
}
