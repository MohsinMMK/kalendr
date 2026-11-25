import { APIError } from "better-auth/api";

import { auth } from "@/lib/auth";
import { staffOwnEmailChangeSchema } from "@/lib/staff-email";
import { ApiError } from "@/server/api-error";
import { emailIsConfigured } from "@/server/auth-email";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotImpersonating, getStaffContext } from "@/server/staff-context";
import { assertOwnEmailChangeAllowed } from "@/server/staff-email-change";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A person asks to change their own sign-in email. Better Auth sends a one-hour link to the NEW address and moves the email only
 * when it is opened; the old address gets a heads-up (the hooks in `src/lib/auth.ts`). The same rules guard a direct call to
 * `/api/auth/change-email`: they run there too, so this route only adds clear errors for the screen.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotImpersonating(staff);
    if (staff.preview || !staff.userId) throw new ApiError(400, "preview_only", "Email changes are unavailable in preview mode.");
    const input = await parseJsonBody(request, staffOwnEmailChangeSchema);
    if (!emailIsConfigured() && process.env.NODE_ENV === "production") {
      throw new ApiError(503, "email_unavailable", "We can't send the confirmation email right now. Please try again shortly.");
    }
    await assertOwnEmailChangeAllowed({ userId: staff.userId, secondFactorAt: staff.secondFactorAt ?? null }, input.newEmail);
    try {
      await auth.api.changeEmail({ headers: request.headers, body: { newEmail: input.newEmail, callbackURL: "/profile" } });
    } catch (error: unknown) {
      if (error instanceof APIError) throw new ApiError(typeof error.statusCode === "number" ? error.statusCode : 400, typeof error.body?.code === "string" ? error.body.code : "email_change_failed", error.body?.message ?? "The email could not be changed.");
      throw error;
    }
    return dataResponse({ sent: true });
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.me.email", requestId);
  }
}
