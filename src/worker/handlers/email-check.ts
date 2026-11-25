import { DEFAULT_ACCENT } from "../../emails/_shared/brand";
import { renderEmail } from "../../server/messaging/email-templates";
import { PermanentSendError, TransientSendError } from "../../server/messaging/provider";
import { openPrivate } from "../../server/messaging/sealed-link";
import { suppressionReason } from "../../server/messaging/suppression";
import type { HandlerDependencies } from "./appointment-message";
import type { EventHandler } from "./types";

/** The outbox event the booking page's "send me a code" request writes (feature 40). */
export const EMAIL_CHECK_EVENT = "email_check.code";

interface CheckRow {
  delivery_sealed: string | null;
  expires_at: Date;
  verified_at: Date | null;
}

/**
 * Sends the 6-digit code that confirms an email address before a booking. The address and the code were sealed for
 * this step and are cleared as soon as the email is handed to the provider. A code that has expired or been used is
 * dropped without sending. Nothing here logs the address or the code.
 */
export function emailCheckHandler({ now, email }: HandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const rows = await tenantDb`
      select delivery_sealed, expires_at, verified_at from email_checks
      where tenant_id = ${event.tenantId} and id = ${event.aggregateId}
      for update
    `;
    const row = rows[0] as CheckRow | undefined;
    if (!row?.delivery_sealed || row.verified_at || row.expires_at <= now()) return "delivered";
    if (!email) return { outcome: "dead", code: "provider_not_configured" };
    const opened = openPrivate("email_check", event.tenantId, event.aggregateId, row.delivery_sealed);
    if (!opened) return { outcome: "dead", code: "sealed_unreadable" };
    let address = "";
    let code = "";
    try {
      const parsed = JSON.parse(opened) as { email?: unknown; code?: unknown };
      address = typeof parsed.email === "string" ? parsed.email : "";
      code = typeof parsed.code === "string" ? parsed.code : "";
    } catch {
      return { outcome: "dead", code: "sealed_unreadable" };
    }
    if (!address || !/^\d{6}$/.test(code)) return { outcome: "dead", code: "invalid_payload" };
    if (await suppressionReason(tenantDb, event.tenantId, "email", address)) return "delivered";

    const [tenant] = await tenantDb`
      select name, email from tenants where id = ${event.tenantId}
    ` as Array<{ name: string; email: string | null }>;
    if (!tenant) return { outcome: "dead", code: "tenant_not_found" };
    const rendered = await renderEmail("booking_code", { code, brand: { businessName: tenant.name, logoUrl: null, accentColor: DEFAULT_ACCENT } });
    try {
      await email.provider.send({
        to: address,
        fromName: tenant.name,
        replyTo: tenant.email?.trim() || email.fallbackReplyTo || undefined,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: `email-check:${event.aggregateId}`,
      });
    } catch (error) {
      if (error instanceof TransientSendError) return { outcome: "retry", code: error.failureCode };
      if (error instanceof PermanentSendError) return { outcome: "dead", code: error.failureCode };
      throw error;
    }
    await tenantDb`update email_checks set delivery_sealed = null where tenant_id = ${event.tenantId} and id = ${event.aggregateId}`;
    return "delivered";
  };
}
