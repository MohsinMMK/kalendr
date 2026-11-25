import { devOAuthEnabled, issueDevGrant } from "@/server/dev-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The development stand-in's "Choose an account" page. Not a real provider; see src/server/dev-oauth.ts. */

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** The redirect target must be this app's own OAuth callback, so the page can't be used to bounce someone elsewhere. */
function safeRedirect(request: Request, target: string | null): URL | null {
  if (!target) return null;
  try {
    const url = new URL(target);
    return url.origin === new URL(request.url).origin && (url.pathname.startsWith("/api/auth/callback/") || url.pathname.startsWith("/api/public/sign-up/callback/")) ? url : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!devOAuthEnabled()) return notFound();
  const query = new URL(request.url).searchParams;
  const redirect = safeRedirect(request, query.get("redirect_uri"));
  if (!redirect) return new Response("Bad redirect", { status: 400 });
  const provider = redirect.pathname.endsWith("/microsoft") ? "Microsoft" : "Google";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${provider} sign-in stand-in</title>
<style>body{font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f4f4f5;color:#18181b}main{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:24px;width:min(360px,92vw)}label{display:block;margin:12px 0 4px;font-size:14px}input[type=email],input[type=text]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d4d4d8;border-radius:8px;font:inherit}button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:#18181b;color:#fff;font:inherit;cursor:pointer}p{font-size:13px;color:#52525b}</style></head>
<body><main><h1 style="font-size:20px;margin:0 0 4px">${provider} (development stand-in)</h1><p>No real ${provider} account is used. Type the email you want to sign in as.</p>
<form method="post"><input type="hidden" name="redirect_uri" value="${escapeHtml(redirect.toString())}"><input type="hidden" name="state" value="${escapeHtml(query.get("state") ?? "")}">
<label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="off">
<label for="name">Name</label><input id="name" name="name" type="text" value="Dev Person">
<label><input type="checkbox" name="verified" value="yes" checked> The provider says this email is verified</label>
<button type="submit">Continue</button></form></main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  if (!devOAuthEnabled()) return notFound();
  const form = await request.formData();
  const redirect = safeRedirect(request, typeof form.get("redirect_uri") === "string" ? String(form.get("redirect_uri")) : null);
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!redirect || !email.includes("@")) return new Response("Bad request", { status: 400 });
  const code = issueDevGrant({ email, name: String(form.get("name") ?? "Dev Person").slice(0, 80) || "Dev Person", verified: form.get("verified") === "yes" });
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", String(form.get("state") ?? ""));
  return new Response(null, { status: 303, headers: { location: redirect.toString(), "cache-control": "no-store" } });
}
