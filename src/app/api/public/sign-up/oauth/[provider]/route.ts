import { isClinicRegistrationOpen } from "@/server/clinic-registration";
import { appOrigin } from "@/server/env";
import { enforceLimit } from "@/server/http";
import { beginSignUpOAuth, providerConfig, type SignUpProvider } from "@/server/sign-up-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts "Sign up with Google / Microsoft" on /start. See src/server/sign-up-oauth.ts. */
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await context.params;
  // The public address, not request.url: behind the proxy that is the container's own (0.0.0.0:3000).
  const back = new URL("/start", `${appOrigin()}/`);
  if (provider !== "google" && provider !== "microsoft") return new Response("Not found", { status: 404 });
  const config = providerConfig(provider as SignUpProvider);
  if (!config || !isClinicRegistrationOpen()) {
    back.searchParams.set("error", "provider_unavailable");
    return Response.redirect(back, 303);
  }
  try {
    await enforceLimit(request, "sign_up_code.ip");
  } catch {
    back.searchParams.set("error", "rate_limited");
    return Response.redirect(back, 303);
  }
  const { location, cookie } = beginSignUpOAuth(provider as SignUpProvider, config);
  return new Response(null, { status: 303, headers: { location, "set-cookie": cookie, "cache-control": "no-store" } });
}
