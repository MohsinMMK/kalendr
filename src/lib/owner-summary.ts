import { z } from "zod";

/**
 * The owner's weekly or monthly summary email. These are the pure rules: which days a period covers, when it may go out,
 * and what the queued payload looks like. The timed job (src/worker/owner-summary-jobs.ts) does the counting.
 */
export const summaryFrequencySchema = z.enum(["off", "weekly", "monthly"]);
export type SummaryFrequency = z.infer<typeof summaryFrequencySchema>;

export const OWNER_SUMMARY_EVENT = "staff.summary";

/** What an owner who never chose gets: the weekly one. Everyone else gets none unless they choose it. */
export function effectiveFrequency(stored: string | null, role: string): SummaryFrequency {
  const parsed = summaryFrequencySchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  return role === "owner" ? "weekly" : "off";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(day: string): Date {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date));
}

function formatDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  const value = parseDay(day);
  value.setUTCDate(value.getUTCDate() + days);
  return formatDay(value);
}

export interface SummaryPeriod {
  /** The first local day covered, "2026-11-16". */
  start: string;
  /** The day after the last one covered. Use it as an exclusive end. */
  end: string;
  /** The same length of time just before, for the change from last time. */
  previousStart: string;
}

/**
 * The period a summary sent on a local day covers, or null when that day is outside the sending window. Weekly covers the
 * Monday-to-Sunday week before, and goes Monday to Wednesday. Monthly covers the month before, and goes on the 1st to the 3rd.
 * The window is three days so a worker that was down on the first day still catches up; the stamp on the person stops a repeat.
 */
export function summaryPeriod(localDay: string, frequency: Exclude<SummaryFrequency, "off">): SummaryPeriod | null {
  if (!DAY.test(localDay)) return null;
  const today = parseDay(localDay);
  if (frequency === "weekly") {
    const isoWeekday = ((today.getUTCDay() + 6) % 7) + 1;
    if (isoWeekday > 3) return null;
    const thisMonday = addDays(localDay, -(isoWeekday - 1));
    return { start: addDays(thisMonday, -7), end: thisMonday, previousStart: addDays(thisMonday, -14) };
  }
  if (today.getUTCDate() > 3) return null;
  const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const lastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const monthBefore = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1));
  return { start: formatDay(lastMonth), end: formatDay(thisMonth), previousStart: formatDay(monthBefore) };
}

export const summaryMetricsSchema = z.object({
  bookings: z.number().int().min(0),
  cancellations: z.number().int().min(0),
  noShows: z.number().int().min(0),
  newCustomers: z.number().int().min(0),
  /** Money taken minus refunds, in the smallest unit of `currency`. */
  revenueMinor: z.number().int(),
});
export type SummaryMetrics = z.infer<typeof summaryMetricsSchema>;

export const ownerSummarySchema = z.object({
  membershipId: z.string().min(1),
  frequency: z.enum(["weekly", "monthly"]),
  /** First local day of the period, "2026-11-16". Doubles as the "already sent" stamp. */
  start: z.string().regex(DAY),
  /** The last local day of the period (inclusive), for the label. */
  last: z.string().regex(DAY),
  currency: z.string().length(3),
  current: summaryMetricsSchema,
  previous: summaryMetricsSchema,
});
export type OwnerSummary = z.infer<typeof ownerSummarySchema>;

/** "+12%", "-5%", "no change", or "new" when last time was zero. Plain words for the email. */
export function changeLabel(current: number, previous: number): string {
  if (current === previous) return "no change";
  if (previous === 0) return current > 0 ? "up from none" : "down from none";
  const percent = Math.round(((current - previous) / Math.abs(previous)) * 100);
  return percent === 0 ? "no change" : `${percent > 0 ? "up" : "down"} ${Math.abs(percent)}%`;
}

export function periodLabel(start: string, last: string): string {
  const format = (day: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", timeZone: "UTC" }).format(parseDay(day));
  return start === last ? format(start) : `${format(start)} to ${format(last)}`;
}

export function previousDay(day: string): string {
  return addDays(day, -1);
}
