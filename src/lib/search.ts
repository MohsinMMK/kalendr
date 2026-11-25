import { z } from "zod";

import type { Permission, StaffRole } from "./permissions";

/** Two characters narrow a list; one letter matches half the directory. The server refuses less. */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 80;

export const searchKinds = ["customer", "appointment", "service", "person", "invoice", "campaign", "routing_form"] as const;
export type SearchKind = (typeof searchKinds)[number];

/** What someone typed, cleaned the way the database function cleans it: trimmed, spaces collapsed, capped. */
export function normaliseSearchQuery(text: string): string {
  // Control characters (a NUL byte makes PostgreSQL refuse the text) become spaces, then runs of spaces collapse.
  return text.replace(/[\p{Cc}\p{Cs}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_LENGTH);
}

export const staffSearchQuerySchema = z.object({
  q: z.string().transform(normaliseSearchQuery).pipe(z.string().min(SEARCH_MIN_LENGTH, "Type at least two characters.")),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  /** The appointment's start or the invoice's issue time, as ISO text. */
  at: string | null;
  /** The business-local day of `at` (YYYY-MM-DD), for opening the schedule on it. */
  day: string | null;
  /** The customer an appointment or invoice belongs to. */
  customerId: string | null;
}

export const searchHitSchema = z.object({
  kind: z.enum(searchKinds),
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  at: z.string().nullable(),
  day: z.string().nullable(),
  customerId: z.string().nullable(),
});

export const staffSearchResultSchema = z.object({ hits: z.array(searchHitSchema) });
export type StaffSearchResult = z.infer<typeof staffSearchResultSchema>;

const any = (permissions: readonly Permission[], wanted: readonly Permission[]) => wanted.some((permission) => permissions.includes(permission));

/**
 * The kinds of record this person may find. Each follows what the matching screen already requires, so search can never
 * show a record the person could not open from the menu. The people who only have their own profile see nothing.
 */
export function searchKindsFor(permissions: readonly Permission[]): SearchKind[] {
  const kinds: SearchKind[] = [];
  if (any(permissions, ["appointments.book", "customers.manage", "appointments.status", "payments.collect", "records.view"])) kinds.push("customer");
  if (any(permissions, ["appointments.book", "appointments.status", "schedule.read"])) kinds.push("appointment");
  if (any(permissions, ["appointments.book", "services.manage", "settings.manage", "schedule.read", "appointments.status"])) kinds.push("service");
  if (any(permissions, ["appointments.book", "team.manage", "settings.manage", "schedule.read", "appointments.status"])) kinds.push("person");
  if (any(permissions, ["invoices.issue", "reports.revenue"])) kinds.push("invoice");
  if (any(permissions, ["campaigns.manage"])) kinds.push("campaign");
  if (any(permissions, ["routing.manage"])) kinds.push("routing_form");
  return kinds;
}

/** Team members who see only their own customers and appointments. */
export function searchIsOwnOnly(role: StaffRole): boolean {
  return role === "practitioner";
}
