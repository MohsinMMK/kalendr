import type { EmailBrand } from "../emails/_shared/brand";
import { renderEmail, type RenderedEmail } from "../server/messaging/email-templates";

const textOf = (value: unknown, fallback = ""): string => (typeof value === "string" ? value.slice(0, 300) : fallback);
const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0);

function fieldsOf(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The owner email for a `billing.*` message. The handler (src/worker/handlers/billing.ts) puts plan names, dates and
 * counts in the body as JSON; nothing about a card, a customer or a person is ever in it. Null means unknown template.
 */
export function renderBillingEmail(templateKey: string, body: string): ((brand: EmailBrand) => Promise<RenderedEmail>) | null {
  const fields = fieldsOf(body);
  if (!fields) return null;
  const billingUrl = textOf(fields.billingUrl);
  const planName = textOf(fields.planName, "your");
  switch (templateKey) {
    case "billing.payment_failed":
      return (brand) => renderEmail("billing_payment_failed", { brand, planName, graceEndsOn: textOf(fields.graceEndsOn), billingUrl });
    case "billing.subscription_started":
      return (brand) => renderEmail("billing_subscription_started", { brand, planName, billingUrl });
    case "billing.trial_ending":
      return (brand) => renderEmail("billing_trial_ending", { brand, endsOn: textOf(fields.endsOn) || textOf(fields.trialEndsOn), billingUrl });
    case "billing.usage_alert":
      return (brand) => renderEmail("billing_usage_alert", {
        brand,
        channelLabel: fields.channel === "sms" ? "text" : "WhatsApp",
        threshold: fields.threshold === 100 ? 100 : 80,
        used: numberOf(fields.used),
        included: numberOf(fields.included),
        billingUrl,
      });
    default:
      return null;
  }
}
