import { ApiError } from "@/server/api-error";
import { providerProof, proofSetCookie } from "@/server/sign-up-check";
import { clearOAuthCookie, finishSignUpOAuth, providerConfig, type SignUpProvider } from "@/server/sign-up-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Google or Microsoft returns here during sign-up. A verified email becomes the sign-up proof; then back to /start. */
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await context.params;
  if (provider !== "google" && provider !== "microsoft") return new Response("Not found", { status: 404 });
  const back = new URL("/start", request.url);
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", clearOAuthCookie);
  const config = providerConfig(provider as SignUpProvider);
  const result = config ? await finishSignUpOAuth(request, provider as SignUpProvider, config) : ({ ok: false, reason: "exchange" } as const);
  if (!result.ok) {
    back.searchParams.set("error", result.reason === "unverified" ? "provider_unverified" : "provider_failed");
  } else {
    try {
      headers.append("set-cookie", proofSetCookie(await providerProof({ email: result.email, name: result.name, method: provider as SignUpProvider })));
    } catch (error: unknown) {
      back.searchParams.set("error", error instanceof ApiError && error.code === "email_taken" ? "email_taken" : "provider_failed");
    }
  }
  headers.set("location", back.toString());
  return new Response(null, { status: 303, headers });
}
