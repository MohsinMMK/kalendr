import { z } from "zod";

/**
 * Reports and analytics (feature 26). The shapes the report routes, the screen and the CSV export all share.
 * No "server-only": the screen and the worker import this file.
 */

export const reportKeys = ["overview", "bookings", "utilisation", "noshows", "revenue", "customers", "sources", "satisfaction"] as const;
export type ReportKey = (typeof reportKeys)[number];

export const reportLabels: Record<ReportKey, string> = {
  overview: "Overview",
  bookings: "Bookings",
  utilisation: "Utilisation",
  noshows: "No-shows and cancellations",
  revenue: "Revenue",
  customers: "Customers",
  sources: "Sources",
  satisfaction: "Satisfaction",
};

/** Reports that show money. They need `reports.revenue` on top of `reports.view`. */
export const revenueReportKeys: readonly ReportKey[] = ["revenue"];

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-30.").refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "That date does not exist.");

/** Longest range one report covers: two years. */
export const MAX_REPORT_DAYS = 731;

export const reportParamsSchema = z.object({
  /** First and last day of the range, in the business's own calendar. Both days are included. */
  from: localDate,
  to: localDate,
  locationId: z.string().min(1).max(80).optional(),
  practitionerId: z.string().min(1).max(80).optional(),
}).refine((value) => value.from <= value.to, { message: "The start must not be after the end.", path: ["to"] })
  .refine((value) => daysBetween(value.from, value.to) < MAX_REPORT_DAYS, { message: "Choose a range of two years or less.", path: ["to"] });
export type ReportParams = z.infer<typeof reportParamsSchema>;

export const reportRequestSchema = z.object({ report: z.enum(reportKeys) });

/** Whole days from one local date to another (to − from), both as YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The range of equal length that ends the day before this one starts. */
export function previousRange(params: Pick<ReportParams, "from" | "to">): { from: string; to: string } {
  const length = daysBetween(params.from, params.to) + 1;
  return { from: addDays(params.from, -length), to: addDays(params.from, -1) };
}

export type MetricFormat = "count" | "money" | "percent" | "hours" | "decimal";

export interface ReportMetric {
  key: string;
  label: string;
  /** Null when there was nothing to divide by (no visits were due, so there is no no-show rate). */
  value: number | null;
  format: MetricFormat;
  /** The same figure for the period before, when the report compares. */
  previous?: number | null;
  /** How the figure is worked out, in one line. */
  formula: string;
  /** Where the rows behind the figure can be checked. */
  href?: string;
}

export interface ReportChart {
  key: string;
  title: string;
  kind: "bar" | "line" | "stacked" | "heat";
  /** The column of `rows` on the horizontal axis. For a heat grid, the weekday label. */
  xKey: string;
  series: { key: string; label: string; format?: MetricFormat }[];
  rows: Record<string, string | number | null>[];
}

export interface ReportColumn {
  key: string;
  label: string;
  format?: MetricFormat | "text" | "date";
}

export interface ReportTable {
  key: string;
  title: string;
  note?: string;
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  /** Row links: the key in each row that holds a path to the rows behind it. */
  hrefKey?: string;
}

export interface ReportResult {
  report: ReportKey;
  range: { from: string; to: string };
  currency: string;
  /** Set when the screen shows only one person's numbers (a practitioner, or a staff filter). */
  scopedToPerson: boolean;
  metrics: ReportMetric[];
  charts: ReportChart[];
  tables: ReportTable[];
}

/** Money for a report cell, in major units for a CSV and with the symbol for the screen. */
export function formatReportValue(value: number | string | null, format: MetricFormat | "text" | "date" | undefined, currency: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || format === "text" || format === "date" || format === undefined) return String(value);
  switch (format) {
    case "money":
      return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(value / 100);
    case "percent":
      return `${(Math.round(value * 10) / 10).toString()}%`;
    case "hours":
      return `${(Math.round(value * 10) / 10).toString()} h`;
    case "decimal":
      return (Math.round(value * 10) / 10).toFixed(1);
    default:
      return new Intl.NumberFormat("en-IN").format(value);
  }
}

/** Percent with one decimal, or null when there was nothing to divide by. */
export function ratePercent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** "Booked hours against available hours": 20 booked of 40 available reads 50. */
export function utilisationPercent(bookedHours: number, availableHours: number): number | null {
  return ratePercent(bookedHours, availableHours);
}

/** The change from the period before, as a signed percent. Null when the earlier figure was zero or missing. */
export function changeFrom(value: number | null, previous: number | null | undefined): number | null {
  if (value === null || previous === null || previous === undefined || previous === 0) return null;
  return Math.round(((value - previous) / Math.abs(previous)) * 1000) / 10;
}

export const exportRequestSchema = z.object({ report: z.enum(reportKeys), params: reportParamsSchema });
export type ExportRequest = z.infer<typeof exportRequestSchema>;

/** The outbox event the worker builds a large export from. */
export const REPORT_EXPORT_EVENT = "report.export";

/** A range longer than this is built by the worker and downloaded from a link. */
export const SYNC_EXPORT_MAX_DAYS = 92;

export interface ExportStatus {
  id: string;
  report: ReportKey;
  status: "pending" | "ready" | "failed";
  filename: string | null;
  createdAt: string;
  expiresAt: string;
}
