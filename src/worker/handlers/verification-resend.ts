import { createEmailVerificationToken } from "better-auth/api";

import { appOrigin, env } from "../../server/env";
import { renderEmail } from "../../server/messaging/email-templates";
import { PermanentSendError, TransientSendError } from "../../server/messaging/provider";
import { suppressionReason } from "../../server/messaging/suppression";
import type { HandlerDependencies } from "./appointment-message";
import type { EventHandler } from "./types";

/** Queued by the platform console's "Resend verification email" (feature 15). The payload holds only the user id. */
export const VERIFICATION_RESEND_EVENT = "account.verification.resend";

const LINK_VALID_SECONDS = 60 * 60;

/**
 * Emails a fresh verification link to the business owner. The worker reads the address itself, with its own role, so
 * the console never sees it. A person who has verified in the meantime, or whose address bounced before, is dropped
 * without sending. The link is the same signed token Better Auth's own sign-in flow sends, valid for an hour.
 */
export function verificationResendHandler({ email }: HandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const [user] = await tenantDb`
      select email, email_verified from auth_users where id = ${event.aggregateId}
    ` as Array<{ email: string; email_verified: boolean }>;
    if (!user || user.email_verified) return "delivered";
    if (!email) return { outcome: "dead", code: "provider_not_configured" };
    const secret = env().BETTER_AUTH_SECRET;
    if (!secret) return { outcome: "dead", code: "auth_not_configured" };
    if (await suppressionReason(tenantDb, event.tenantId, "email", user.email)) return "delivered";

    const token = await createEmailVerificationToken(secret, user.email, undefined, LINK_VALID_SECONDS);
    const url = `${appOrigin()}/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent("/sign-in")}`;
    const rendered = await renderEmail("email_verification", { url });
    try {
      await email.provider.send({
        to: user.email,
        replyTo: email.fallbackReplyTo ?? undefined,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: `admin-verify:${event.id}`,
      });
    } catch (error) {
      if (error instanceof TransientSendError) return { outcome: "retry", code: error.failureCode };
      if (error instanceof PermanentSendError) return { outcome: "dead", code: error.failureCode };
      throw error;
    }
    return "delivered";
  };
}
