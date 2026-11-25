import { accountEmailNoticePayloadSchema, accountEmailNoticeSecretSchema, ACCOUNT_EMAIL_NOTICE_PURPOSE } from "../../lib/staff-email";
import { renderEmail } from "../../server/messaging/email-templates";
import { PermanentSendError, TransientSendError } from "../../server/messaging/provider";
import { openPrivate } from "../../server/messaging/sealed-link";
import { suppressionReason } from "../../server/messaging/suppression";
import type { HandlerDependencies } from "./appointment-message";
import type { EventHandler } from "./types";

/**
 * Sends one "your sign-in email changed" notice (`account.email_notice`). The address was sealed when the change was made and is
 * opened only here, for the send; nothing in this file logs it, the name or the business. A notice for an address on the
 * suppression list is dropped without sending, and the provider's idempotency key is the outbox row, so a retry sends once.
 */
export function accountEmailNoticeHandler({ email }: Pick<HandlerDependencies, "email">): EventHandler {
  return async (tenantDb, event) => {
    const payload = accountEmailNoticePayloadSchema.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    if (!email) return { outcome: "dead", code: "provider_not_configured" };
    const opened = openPrivate(ACCOUNT_EMAIL_NOTICE_PURPOSE, event.tenantId, event.aggregateId, payload.data.sealed);
    if (!opened) return { outcome: "dead", code: "sealed_unreadable" };
    let secret: ReturnType<typeof accountEmailNoticeSecretSchema.safeParse>;
    try {
      secret = accountEmailNoticeSecretSchema.safeParse(JSON.parse(opened));
    } catch {
      return { outcome: "dead", code: "sealed_unreadable" };
    }
    if (!secret.success) return { outcome: "dead", code: "invalid_payload" };
    const { email: address, name, business, when } = secret.data;
    if (await suppressionReason(tenantDb, event.tenantId, "email", address)) return "delivered";
    const rendered = await renderEmail("account_email_change", { kind: payload.data.kind, name, business, when });
    try {
      await email.provider.send({
        to: address,
        fromName: business || undefined,
        replyTo: email.fallbackReplyTo ?? undefined,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: `account-email-notice:${event.aggregateId}`,
      });
    } catch (error) {
      if (error instanceof TransientSendError) return { outcome: "retry", code: error.failureCode };
      if (error instanceof PermanentSendError) return { outcome: "dead", code: error.failureCode };
      throw error;
    }
    return "delivered";
  };
}
