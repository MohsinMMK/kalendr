"use client";

import { keepPreviousData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { type BookingFilter, bookingQueryToParams } from "@/lib/bookings-list";
import type { SeriesListPage, SeriesListRow } from "@/lib/series-list";

import { StaffApiError } from "./queries/http";
import { staffQuery } from "./staff-snapshot-provider";

const seriesKey = ["staff", "bookings", "series"] as const;

/** The Repeating tab's series, one page at a time. Counts come with the first page and stay while paging. */
export function useSeriesList(filter: BookingFilter, sort: "asc" | "desc", enabled: boolean) {
  const queryString = bookingQueryToParams({ ...filter, sort: sort === "asc" ? undefined : sort }).toString();
  const result = useInfiniteQuery({
    queryKey: [...seriesKey, queryString],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = bookingQueryToParams({ ...filter, sort: sort === "asc" ? undefined : sort, cursor: pageParam });
      return staffQuery<SeriesListPage>(`/api/staff/bookings/series?${params.toString()}`, signal);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const pages = result.data?.pages ?? [];
  const seen = new Set<string>();
  const rows: SeriesListRow[] = [];
  for (const page of pages) for (const row of page.rows) if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
  const previewOnly = result.error instanceof StaffApiError && result.error.code === "preview_only";
  return {
    rows, counts: pages[0]?.counts ?? null, repeatingCount: pages[0]?.repeatingCount ?? null,
    hasMore: result.hasNextPage, loadingMore: result.isFetchingNextPage, loadMore: () => void result.fetchNextPage(),
    loading: result.isPending && enabled && !previewOnly, refreshing: result.isFetching && !result.isPending,
    stale: result.isPlaceholderData, previewOnly,
    error: result.isError && !previewOnly ? result.error.message : "",
    refetch: () => result.refetch(),
  };
}

/** After a change to a series: reload the list, so the next visit, the counts and the status are fresh. */
export function useRefreshSeriesList() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: ["staff", "bookings"] }), [client]);
}
