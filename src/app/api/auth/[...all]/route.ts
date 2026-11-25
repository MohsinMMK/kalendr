import { toNextJsHandler } from "better-auth/next-js";

import { auth, authIsConfigured } from "@/lib/auth";
import { ApiError } from "@/server/api-error";
import { enforceLimit } from "@/server/http";
import { clientAddress } from "@/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = toNextJsHandler(auth);

export const GET = withConfiguredAuth(handlers.GET);
export const POST = withConfiguredAuth(withSignInLimits(handlers.POST));

function withConfiguredAuth(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!authIsConfigured) {
      return Response.json(
        {
          error: {
            code: "auth_unavailable",
            message: "Staff sign-in is not configured.",
          },
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return handler(request);
  };
}

/**
 * Staff sign-in: 10 attempts per 15 minutes per IP and per email, counted in the shared
 * database so every app server agrees. The refusal uses Better Auth's error shape so the
 * sign-in form reads it like any other sign-in error.
 */
function withSignInLimits(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    const isPassword = pathname.endsWith("/sign-in/email");
    const isMagicLink = pathname.endsWith("/sign-in/magic-link");
    if (!isPassword && !isMagicLink) return handler(request);
    try {
      await enforceLimit(request, isMagicLink ? "magic_link.ip" : "staff_sign_in.ip", clientAddress(request.headers));
      const email = await signInEmail(request);
      if (email) await enforceLimit(request, isMagicLink ? "magic_link.email" : "staff_sign_in.email", email);
    } catch (error: unknown) {
      if (!(error instanceof ApiError)) throw error;
      return Response.json(
        { code: "TOO_MANY_REQUESTS", message: error.message },
        { status: error.status, headers: { ...error.headers, "Cache-Control": "no-store" } },
      );
    }
    return handler(request);
  };
}

async function signInEmail(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.clone().json();
    if (typeof body !== "object" || body === null || !("email" in body) || typeof body.email !== "string") return null;
    const email = body.email.trim().toLowerCase();
    return email.length > 0 && email.length <= 254 ? email : null;
  } catch {
    return null;
  }
}
