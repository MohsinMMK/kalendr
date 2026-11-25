import { z } from "zod";

import type { EmailBrand } from "../emails/_shared/brand";
import { renderEmail, type RenderedEmail } from "../server/messaging/email-templates";

const line = z.object({ time: z.string().max(40), service: z.string().max(160), firstName: z.string().max(80) });
const alertBody = z.object({ title: z.string().min(1).max(140), detail: z.string().max(140).default(""), url: z.string().max(400) });
const digestBody = z.object({
  dayLabel: z.string().max(60),
  today: z.array(line).max(60),
  todayCount: z.number().int().min(0),
  waiting: z.number().int().min(0),
  cancelled: z.array(line).max(30),
  staffUrl: z.string().max(400),
});

const summaryBody = z.object({
  periodWord: z.string().max(12),
  periodLabel: z.string().max(80),
  rows: z.array(z.object({ label: z.string().max(40), value: z.string().max(40), change: z.string().max(40) })).max(10),
  reportsUrl: z.string().max(400),
});

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** The email for a `staff.*` message. The handler (src/worker/handlers/staff-notify.ts) put first names, services and times in the body as JSON. */
export function renderStaffEmail(templateKey: string, body: string): ((brand: EmailBrand) => Promise<RenderedEmail>) | null {
  if (templateKey === "staff.alert") {
    const parsed = alertBody.safeParse(json(body));
    return parsed.success ? (brand) => renderEmail("staff_alert", { brand, ...parsed.data }) : null;
  }
  if (templateKey === "staff.digest") {
    const parsed = digestBody.safeParse(json(body));
    return parsed.success ? (brand) => renderEmail("staff_digest", { brand, ...parsed.data }) : null;
  }
  if (templateKey === "staff.summary") {
    const parsed = summaryBody.safeParse(json(body));
    return parsed.success ? (brand) => renderEmail("owner_summary", { brand, ...parsed.data }) : null;
  }
  return null;
}
