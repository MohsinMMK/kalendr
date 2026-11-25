import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import type { InvoiceList, InvoiceView, TaxSettingsView } from "@/lib/invoicing-contracts";

import { staffKeys } from "./keys";
import { staffQuery } from "./http";

export type InvoiceStateFilter = "all" | "due" | "paid" | "credited";
export interface InvoiceFilters { state: InvoiceStateFilter; /** "YYYY-MM", or "" for every month. */ month: string }

export const invoiceKeys = {
  all: () => [...staffKeys.all, "invoices"] as const,
  list: (filters: InvoiceFilters) => [...staffKeys.all, "invoices", "list", filters.state, filters.month] as const,
  one: (id: string) => [...staffKeys.all, "invoices", "one", id] as const,
  taxSettings: () => [...staffKeys.all, "tax-settings"] as const,
};

function listPath(filters: InvoiceFilters, cursor: string | null): string {
  const params = new URLSearchParams({ state: filters.state, limit: "30" });
  // The server refuses an empty month, so "every month" leaves it out.
  if (filters.month) params.set("month", filters.month);
  if (cursor) params.set("cursor", cursor);
  return `/api/staff/invoices?${params.toString()}`;
}

/** GET /api/staff/invoices: newest first, a page at a time. */
export function useInvoiceList(filters: InvoiceFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: invoiceKeys.list(filters),
    queryFn: ({ pageParam, signal }) => staffQuery<InvoiceList>(listPath(filters, pageParam), signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

/** GET /api/staff/invoices/[id]. */
export function useInvoice(id: string | null) {
  return useQuery({ queryKey: invoiceKeys.one(id ?? ""), queryFn: ({ signal }) => staffQuery<InvoiceView>(`/api/staff/invoices/${id}`, signal), enabled: Boolean(id) });
}

/** GET /api/staff/tax-settings. */
export function useTaxSettings(enabled = true) {
  return useQuery({ queryKey: invoiceKeys.taxSettings(), queryFn: ({ signal }) => staffQuery<TaxSettingsView>("/api/staff/tax-settings", signal), enabled });
}
