"use client";

import { parseAsArrayOf, parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";

import { appointmentStatusSchema } from "@/lib/contracts";
import { type BookingFilter, type BookingQuery, bookingSources, defaultSortFor, type SavedView, seriesStatuses, type WorkspaceTab, workspaceTabs } from "@/lib/bookings-list";

/**
 * The tab, sort and every filter live in the address bar under the same names the API reads, so a copied
 * link opens the same view and the same text builds the request. Lists are comma-separated.
 */
export const bookingParsers = {
  tab: parseAsStringLiteral(workspaceTabs),
  sort: parseAsStringLiteral(["asc", "desc"] as const),
  practitionerIds: parseAsArrayOf(parseAsString),
  serviceIds: parseAsArrayOf(parseAsString),
  locationIds: parseAsArrayOf(parseAsString),
  statuses: parseAsArrayOf(parseAsString),
  sources: parseAsArrayOf(parseAsString),
  seriesStatuses: parseAsArrayOf(parseAsString),
  from: parseAsString,
  to: parseAsString,
  q: parseAsString,
  utmSource: parseAsString,
  utmCampaign: parseAsString,
  /** The columns of an applied saved view (it is not sent to the API). Absent means the business's own columns. */
  columns: parseAsArrayOf(parseAsString),
};

export function useBookingsUrl() {
  return useQueryStates(bookingParsers, { history: "push", clearOnDefault: true });
}

export type BookingsUrl = ReturnType<typeof useBookingsUrl>[0];
export type BookingsUrlPatch = Partial<{ [K in keyof typeof bookingParsers]: BookingsUrl[K] }>;

const statusValues = new Set<string>(appointmentStatusSchema.options);
const sourceValues = new Set<string>(bookingSources);
const seriesStatusValues = new Set<string>(seriesStatuses);

/** Link text that is not a known value is dropped instead of failing the whole request. */
export function filtersFromUrl(url: BookingsUrl): BookingFilter {
  const list = (value: string[] | null) => (value && value.length > 0 ? value : undefined);
  const statuses = list(url.statuses?.filter((item) => statusValues.has(item)) ?? null);
  const sources = list(url.sources?.filter((item) => sourceValues.has(item)) ?? null);
  const seriesChosen = list(url.seriesStatuses?.filter((item) => seriesStatusValues.has(item)) ?? null);
  const filter: BookingFilter = {
    seriesStatuses: seriesChosen as BookingFilter["seriesStatuses"],
    practitionerIds: list(url.practitionerIds), serviceIds: list(url.serviceIds), locationIds: list(url.locationIds),
    statuses: statuses as BookingFilter["statuses"], sources: sources as BookingFilter["sources"],
    from: url.from ?? undefined, to: url.to ?? undefined, q: url.q ?? undefined, utmSource: url.utmSource ?? undefined, utmCampaign: url.utmCampaign ?? undefined,
  };
  return Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined)) as BookingFilter;
}

export function queryFromUrl(url: BookingsUrl): Omit<Partial<BookingQuery>, "tab"> & { tab: WorkspaceTab } {
  const tab = url.tab ?? "upcoming";
  return { ...filtersFromUrl(url), tab, ...(url.sort && url.sort !== defaultSortFor(tab) ? { sort: url.sort } : {}) };
}

/** The Repeating tab (feature 17) uses only these filters; the rest of the filter set is kept but does not apply to it. */
export function activeFilterCount(filter: BookingFilter, tab?: WorkspaceTab): number {
  if (tab === "repeating") {
    return [filter.practitionerIds, filter.serviceIds, filter.locationIds, filter.seriesStatuses].filter((item) => item && item.length > 0).length + (filter.q ? 1 : 0);
  }
  const days = filter.from || filter.to ? 1 : 0;
  const lists = [filter.practitionerIds, filter.serviceIds, filter.locationIds, filter.statuses, filter.sources].filter((item) => item && item.length > 0).length;
  return days + lists + [filter.q, filter.utmSource, filter.utmCampaign].filter(Boolean).length;
}

const clearedFilters: BookingsUrlPatch = { practitionerIds: null, serviceIds: null, locationIds: null, statuses: null, sources: null, seriesStatuses: null, from: null, to: null, q: null, utmSource: null, utmCampaign: null };
export const clearFilterPatch = clearedFilters;

/** What to write to the address to show a filter set: every key it lacks is cleared. */
export function filterPatch(filter: BookingFilter): BookingsUrlPatch {
  return {
    ...clearedFilters,
    practitionerIds: filter.practitionerIds?.length ? filter.practitionerIds : null,
    serviceIds: filter.serviceIds?.length ? filter.serviceIds : null,
    locationIds: filter.locationIds?.length ? filter.locationIds : null,
    statuses: filter.statuses?.length ? filter.statuses : null,
    sources: filter.sources?.length ? filter.sources : null,
    seriesStatuses: filter.seriesStatuses?.length ? filter.seriesStatuses : null,
    from: filter.from ?? null, to: filter.to ?? null, q: filter.q ?? null, utmSource: filter.utmSource ?? null, utmCampaign: filter.utmCampaign ?? null,
  };
}

/** A saved view applied in one write: its tab, filters, sort and columns replace what the address held. */
export function viewPatch(view: SavedView): BookingsUrlPatch {
  return { ...filterPatch(view.filters), tab: view.tab, sort: view.sort === defaultSortFor(view.tab) ? null : view.sort, columns: view.columns.length > 0 ? [...view.columns] : null };
}
