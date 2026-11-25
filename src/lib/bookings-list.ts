import { z } from "zod";

import { appointmentStatusSchema } from "@/lib/contracts";

/**
 * The bookings list (feature 43): its tabs, filters, columns and saved views. One set of shapes shared by the
 * screen, the address bar, the route and the query builder, so a link reproduces the same view.
 */

export const bookingTabs = ["upcoming", "needs_approval", "past", "cancelled"] as const;
export type BookingTab = (typeof bookingTabs)[number];
export const bookingTabLabels: Record<BookingTab, string> = {
  upcoming: "Upcoming",
  needs_approval: "Needs approval",
  past: "Past",
  cancelled: "Cancelled",
};
/**
 * The Repeating tab (feature 17) lists series, not bookings, so it is a screen-level tab: it has its own query, route and rows
 * (`series-list.ts`) and never goes through the booking query. Everything that keys on a booking tab keeps using `bookingTabs`.
 */
export const workspaceTabs = [...bookingTabs, "repeating"] as const;
export type WorkspaceTab = (typeof workspaceTabs)[number];
export const workspaceTabLabels: Record<WorkspaceTab, string> = { ...bookingTabLabels, repeating: "Repeating" };
export const seriesStatuses = ["active", "ended", "cancelled"] as const;
export type SeriesStatus = (typeof seriesStatuses)[number];
export const seriesStatusLabels: Record<SeriesStatus, string> = { active: "Running", ended: "Ended", cancelled: "Cancelled" };

/** Past and Cancelled read newest first; the others by start time. */
export const defaultSortFor = (tab: WorkspaceTab): "asc" | "desc" => (tab === "past" || tab === "cancelled" ? "desc" : "asc");

export const bookingSources = ["online", "staff", "widget", "recall", "waitlist", "iframe", "phone", "walk_in", "assistant"] as const;
export const bookingSourceLabels: Record<(typeof bookingSources)[number], string> = {
  online: "Booking page",
  staff: "Front desk",
  widget: "Website button",
  recall: "Reminder to return",
  waitlist: "Waitlist",
  iframe: "Embedded page",
  phone: "Phone call",
  walk_in: "Walk-in",
  assistant: "Booking assistant",
};

const idSchema = z.string().trim().min(1).max(160);
const idList = z.array(idSchema).max(50);

export const bookingFilterSchema = z.object({
  practitionerIds: idList.optional(),
  serviceIds: idList.optional(),
  locationIds: idList.optional(),
  statuses: z.array(appointmentStatusSchema).max(16).optional(),
  sources: z.array(z.enum(bookingSources)).max(9).optional(),
  /** Repeating tab only: which series. Nothing chosen means the running ones. */
  seriesStatuses: z.array(z.enum(seriesStatuses)).max(3).optional(),
  /** An instant with an offset. The screen turns a picked day into the business's own midnight. */
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  /** A name or part of a phone number. */
  q: z.string().trim().max(80).optional(),
  utmSource: z.string().trim().max(100).optional(),
  utmCampaign: z.string().trim().max(100).optional(),
});
export type BookingFilter = z.infer<typeof bookingFilterSchema>;

export const BOOKINGS_PAGE_MAX = 100;
export const BOOKINGS_PAGE_DEFAULT = 50;

export const bookingQuerySchema = bookingFilterSchema.extend({
  tab: z.enum(bookingTabs).default("upcoming"),
  sort: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().trim().max(400).optional(),
  limit: z.number().int().min(1).max(BOOKINGS_PAGE_MAX).default(BOOKINGS_PAGE_DEFAULT),
});
export type BookingQuery = z.infer<typeof bookingQuerySchema>;

const listKeys = ["practitionerIds", "serviceIds", "locationIds", "statuses", "sources", "seriesStatuses"] as const;
const textKeys = ["from", "to", "q", "utmSource", "utmCampaign", "tab", "sort", "cursor"] as const;

/** Reads a query string into the query object. Lists are comma-separated; anything that does not fit is refused by the schema. */
export function bookingQueryFromParams(params: URLSearchParams): unknown {
  const raw: Record<string, unknown> = {};
  for (const key of listKeys) {
    const value = params.get(key);
    if (value) raw[key] = value.split(",").map((part) => part.trim()).filter(Boolean);
  }
  for (const key of textKeys) {
    const value = params.get(key);
    if (value) raw[key] = value;
  }
  const limit = params.get("limit");
  if (limit) raw.limit = Number(limit);
  return raw;
}

/** The query as a query string, leaving out what is empty or default. The address bar and the API use the same text. */
export function bookingQueryToParams(query: Partial<BookingQuery>): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of listKeys) {
    const list = query[key];
    if (list && list.length > 0) params.set(key, list.join(","));
  }
  for (const key of textKeys) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  if (query.limit && query.limit !== BOOKINGS_PAGE_DEFAULT) params.set("limit", String(query.limit));
  return params;
}

export const bookingColumns = ["time", "customer", "service", "person", "branch", "status", "source", "channel", "price"] as const;
export type BookingColumn = (typeof bookingColumns)[number];
export const bookingColumnLabels: Record<BookingColumn, string> = {
  time: "Time",
  customer: "Customer",
  service: "Service",
  person: "Person",
  branch: "Branch",
  status: "Status",
  source: "Booked via",
  channel: "Source",
  price: "Price",
};
export const defaultBookingColumns: BookingColumn[] = ["time", "customer", "service", "person", "status", "source"];

export interface BookingRow {
  id: string;
  version: number;
  startsAt: string;
  endsAt: string;
  status: z.infer<typeof appointmentStatusSchema>;
  bookingSource: (typeof bookingSources)[number];
  customer: { id: string; name: string; phone: string };
  service: { id: string; name: string };
  practitioner: { id: string; name: string };
  location: { id: string; name: string };
  priceMinor: number | null;
  referrerHost: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  /** When staff asked the customer to move it, or null. */
  rescheduleRequestedAt: string | null;
  /** How many other times the customer offered, for a request. */
  proposedCount: number;
}

export interface BookingPage {
  rows: BookingRow[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  /** Counts for every tab under the same filters, so the tabs show what is behind them. Null after the first page. */
  counts: Record<BookingTab, number> | null;
  /** The Repeating tab's count (feature 17), with the first page. */
  repeatingCount?: number | null;
}

export const SAVED_VIEW_NAME_MAX = 80;
export const MAX_SAVED_VIEWS = 50;

/** What a saved view keeps: the filters, the sort and the columns. The tab is part of the view. */
export const savedViewInputSchema = z.object({
  name: z.string().trim().min(2).max(SAVED_VIEW_NAME_MAX),
  shared: z.boolean().default(false),
  tab: z.enum(workspaceTabs).default("upcoming"),
  filters: bookingFilterSchema,
  sort: z.enum(["asc", "desc"]).default("asc"),
  columns: z.array(z.enum(bookingColumns)).max(bookingColumns.length).default([]),
});
export type SavedViewInput = z.infer<typeof savedViewInputSchema>;

export interface SavedView {
  id: string;
  name: string;
  shared: boolean;
  /** True when it belongs to the person asking, who may remove it. */
  mine: boolean;
  tab: WorkspaceTab;
  filters: BookingFilter;
  sort: "asc" | "desc";
  columns: BookingColumn[];
}

export const bulkActions = ["confirm", "cancel", "mark_no_show", "reassign", "message", "report_spam"] as const;
export type BulkAction = (typeof bulkActions)[number];
export const BULK_MAX = 100;

export const bulkInputSchema = z.object({
  action: z.enum(bulkActions),
  items: z.array(z.object({ id: idSchema, expectedVersion: z.number().int().positive() })).min(1).max(BULK_MAX),
  /** For `cancel`: a preset reason. */
  presetId: idSchema.optional(),
  /** For `reassign`: the person who takes the bookings. */
  practitionerId: idSchema.optional(),
  /** For `message`: one of the ready-made messages staff already send from Today. */
  messageKind: z.enum(["call_us", "running_late"]).optional(),
  /** For `running_late`: how many minutes late. */
  delayMinutes: z.number().int().min(5).max(180).optional(),
  /** For `report_spam` (feature 44): a fixed reason. */
  reasonCode: z.enum(["fake_details", "abusive", "duplicate", "other"]).optional(),
  /** For `cancel`: tell the customers (default) or not. */
  notifyCustomers: z.boolean().optional(),
}).superRefine((value, context) => {
  if (value.action === "reassign" && !value.practitionerId) context.addIssue({ code: "custom", path: ["practitionerId"], message: "Choose who takes these bookings." });
  if (value.action === "report_spam" && !value.reasonCode) context.addIssue({ code: "custom", path: ["reasonCode"], message: "Choose why these are spam." });
  if (value.action === "message" && !value.messageKind) context.addIssue({ code: "custom", path: ["messageKind"], message: "Choose a message to send." });
  if (value.action === "message" && value.messageKind === "running_late" && !value.delayMinutes) context.addIssue({ code: "custom", path: ["delayMinutes"], message: "Say how late." });
});
export type BulkInput = z.infer<typeof bulkInputSchema>;

export interface BulkResult {
  results: Array<{ id: string; ok: boolean; code?: string; message?: string }>;
  succeeded: number;
  failed: number;
}

/** One line of a booking's history, in words. Encrypted notes never appear here. */
export interface HistoryEntry {
  at: string;
  kind: "audit" | "message";
  action: string;
  label: string;
  /** Who did it: staff by name, the customer, or the system. */
  actor: { type: "staff" | "patient" | "system"; name?: string };
  /** Extra plain words, such as "Dr Rao → Dr Shah" or a reason label. */
  detail?: string;
}
