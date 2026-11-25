import { appOrigin } from "../../server/env";
import { changeLabel, ownerSummarySchema, periodLabel } from "../../lib/owner-summary";
import { formatMoney } from "../../lib/money";
import { staffDigestSchema, staffEmailJobSchema } from "../../lib/staff-alerts";
import { deliveryToHandlerOutcome, type HandlerDependencies } from "./appointment-message";
import type { EventHandler, TenantDb } from "./types";

/** The person's own sign-in address. Staff are looked up by their membership, never by anything the alert carries. */
async function staffAddress(tenantDb: TenantDb, tenantId: string, membershipId: string): Promise<{ email: string; name: string } | null> {
  const [row] = await tenantDb<{ email: string | null; name: string | null }[]>`
    select account.email, account.name from memberships as membership
    join auth_users as account on account.id = membership.user_id
    where membership.tenant_id = ${tenantId} and membership.id = ${membershipId} and membership.is_active`;
  const email = row?.email?.trim();
  return email ? { email, name: row?.name?.trim() || "there" } : null;
}

/**
 * One alert as an email to the staff member who chose it (feature 56). Quiet hours were already applied when the row was queued
 * (it was not available until they ended). The body holds the title and a first name, a service and a time, never a phone, email or note.
 */
export function staffEmailHandler({ sink, now }: Pick<HandlerDependencies, "sink" | "now">): EventHandler {
  return async (tenantDb, event) => {
    const job = staffEmailJobSchema.safeParse(event.payload);
    if (!job.success) return { outcome: "dead", code: "invalid_payload" };
    const recipient = await staffAddress(tenantDb, event.tenantId, job.data.membershipId);
    if (!recipient) return "delivered";
    const at = now();
    return deliveryToHandlerOutcome(await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: "",
      channel: "email",
      message: {
        semanticKey: `local:staff:${event.dedupeKey}`,
        templateKey: "staff.alert",
        body: JSON.stringify({ title: job.data.title, detail: job.data.body ?? "", url: `${appOrigin()}${job.data.link ?? "/schedule"}` }),
        scheduledAt: at,
      },
      recipient,
    }, at));
  };
}

/** One person's morning summary as an email. The timed job decided what goes in it and when; this only sends it. */
export function staffDigestHandler({ sink, now }: Pick<HandlerDependencies, "sink" | "now">): EventHandler {
  return async (tenantDb, event) => {
    const digest = staffDigestSchema.safeParse(event.payload);
    if (!digest.success) return { outcome: "dead", code: "invalid_payload" };
    const recipient = await staffAddress(tenantDb, event.tenantId, digest.data.membershipId);
    if (!recipient) return "delivered";
    const at = now();
    const { day, today, todayCount, waiting, cancelled } = digest.data;
    return deliveryToHandlerOutcome(await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: "",
      channel: "email",
      message: {
        semanticKey: `local:staff:${event.dedupeKey}`,
        templateKey: "staff.digest",
        body: JSON.stringify({ today, todayCount, waiting, cancelled, dayLabel: dayLabel(day), staffUrl: `${appOrigin()}/schedule` }),
        scheduledAt: at,
      },
      recipient,
    }, at));
  };
}

/** "Friday 20 November" from "2026-11-20". The date is a plain calendar day, so no time zone is involved. */
export function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, date))).replace(",", "");
}

/**
 * One owner's weekly or monthly summary as an email. The timed job counted the period and chose the owner; this words the
 * numbers and sends them. The body holds counts and one money figure, never a name, contact detail or note. It uses the
 * business's own words for bookings and customers, so a salon reads "appointments" and a consultancy "bookings".
 */
export function ownerSummaryHandler({ sink, now }: Pick<HandlerDependencies, "sink" | "now">): EventHandler {
  return async (tenantDb, event) => {
    const summary = ownerSummarySchema.safeParse(event.payload);
    if (!summary.success) return { outcome: "dead", code: "invalid_payload" };
    const recipient = await staffAddress(tenantDb, event.tenantId, summary.data.membershipId);
    if (!recipient) return "delivered";
    const at = now();
    const { current, previous, currency, frequency, start, last } = summary.data;
    const row = (label: string, now_: number, before: number) => ({ label, value: String(now_), change: changeLabel(now_, before) });
    const rows = [
      row("Bookings", current.bookings, previous.bookings),
      row("Cancellations", current.cancellations, previous.cancellations),
      row("No-shows", current.noShows, previous.noShows),
      row("New customers", current.newCustomers, previous.newCustomers),
      { label: "Revenue", value: formatMoney(current.revenueMinor, currency), change: changeLabel(current.revenueMinor, previous.revenueMinor) },
    ];
    return deliveryToHandlerOutcome(await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: "",
      channel: "email",
      message: {
        semanticKey: `local:staff:${event.dedupeKey}`,
        templateKey: "staff.summary",
        body: JSON.stringify({ periodWord: frequency === "weekly" ? "week" : "month", periodLabel: periodLabel(start, last), rows, reportsUrl: `${appOrigin()}/reports` }),
        scheduledAt: at,
      },
      recipient,
    }, at));
  };
}
