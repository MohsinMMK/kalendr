import type { EmailBrand } from "../emails/_shared/brand";
import { isOwnerNoticeKind, ownerNoticeContent } from "../lib/owner-notices";
import { renderEmail, type RenderedEmail } from "../server/messaging/email-templates";

const textOf = (value: unknown): string => (typeof value === "string" ? value.slice(0, 300) : "");

/**
 * The owner email for an `owner.*` message (features 11 and 13): the handler put a kind and a few plain fields in the
 * body as JSON. Null means an unknown kind or a body that is not ours, which the adapter rejects.
 */
export function renderOwnerEmail(templateKey: string, body: string): ((brand: EmailBrand) => Promise<RenderedEmail>) | null {
  let fields: unknown;
  try {
    fields = JSON.parse(body);
  } catch {
    return null;
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const record = fields as Record<string, unknown>;
  const kind = templateKey.slice("owner.".length);
  if (!isOwnerNoticeKind(kind)) return null;
  const hostname = textOf(record.hostname);
  const dashboardUrl = textOf(record.dashboardUrl);
  const bookingUrl = textOf(record.bookingUrl);
  const content = ownerNoticeContent(kind, {
    ...(hostname ? { hostname } : {}), settingsUrl: textOf(record.settingsUrl),
    ...(dashboardUrl ? { dashboardUrl } : {}), ...(bookingUrl ? { bookingUrl } : {}),
    ...(typeof record.done === "number" ? { done: record.done } : {}), ...(typeof record.total === "number" ? { total: record.total } : {}),
  });
  return (brand) => renderEmail("owner_notice", { brand, subject: content.subject, heading: content.heading, paragraphs: content.paragraphs, button: content.button });
}
