import { createHash } from "node:crypto";

import { devOAuthEnabled, readDevGrant } from "@/server/dev-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The development stand-in's userinfo endpoint. */
export async function GET(request: Request): Promise<Response> {
  if (!devOAuthEnabled()) return new Response("Not found", { status: 404 });
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const grant = readDevGrant(token);
  if (!grant) return Response.json({ error: "invalid_token" }, { status: 401 });
  const subject = createHash("sha256").update(`dev:${grant.email}`).digest("hex").slice(0, 24);
  return Response.json({
    // Better Auth's generic provider takes the account's identity from `id`.
    id: subject,
    sub: subject,
    email: grant.email,
    email_verified: grant.verified,
    name: grant.name,
  });
}
