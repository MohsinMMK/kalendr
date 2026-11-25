"use client";

import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { type BookingPage, type BookingQuery, type BookingRow, type BulkInput, type BulkResult, bookingQueryToParams, type SavedView, type SavedViewInput } from "@/lib/bookings-list";
import type { CancelPreset } from "@/lib/cancel-policy";

import { StaffApiError } from "./queries/http";
import { staffKeys } from "./queries/keys";
import { staffMutation, staffQuery } from "./staff-snapshot-provider";

const bookingsKey = staffKeys.bookings();
const viewsKey = ["staff", "saved-views"] as const;

/** The list for one tab and filter set, one page at a time. Counts come with the first page and stay while paging. */
export function useBookingList(query: Partial<BookingQuery>, enabled: boolean) {
  const queryString = bookingQueryToParams(query).toString();
  const result = useInfiniteQuery({
    queryKey: staffKeys.bookingList(queryString),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = bookingQueryToParams({ ...query, cursor: pageParam });
      return staffQuery<BookingPage>(`/api/staff/bookings?${params.toString()}`, signal);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const pages = result.data?.pages ?? [];
  const seen = new Set<string>();
  const rows: BookingRow[] = [];
  for (const page of pages) for (const row of page.rows) if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
  const previewOnly = result.error instanceof StaffApiError && result.error.code === "preview_only";
  return {
    rows, counts: pages[0]?.counts ?? null, repeatingCount: pages[0]?.repeatingCount ?? null, hasMore: result.hasNextPage, loadingMore: result.isFetchingNextPage,
    loadMore: () => void result.fetchNextPage(),
    loading: result.isPending && !previewOnly, refreshing: result.isFetching && !result.isPending,
    stale: result.isPlaceholderData, previewOnly,
    error: result.isError && !previewOnly ? result.error.message : "",
    refetch: () => result.refetch(),
  };
}

/** After an action: reload every loaded page, so counts, versions and the rows that failed are all fresh. */
export function useRefreshBookings() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: bookingsKey }), [client]);
}

export function useSavedViews(enabled: boolean) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: viewsKey, enabled, queryFn: ({ signal }) => staffQuery<SavedView[]>("/api/staff/saved-views", signal) });
  return {
    views: query.data ?? [],
    loading: query.isPending && enabled,
    failed: query.isError,
    refresh: () => client.invalidateQueries({ queryKey: viewsKey }),
  };
}

export const createSavedView = (input: SavedViewInput) => staffMutation<SavedView>("/api/staff/saved-views", "POST", input);
export const deleteSavedView = (id: string) => staffMutation<unknown>(`/api/staff/saved-views?id=${encodeURIComponent(id)}`, "DELETE", undefined);

/** One action on up to 100 bookings. A fresh key per attempt, so each action the person takes runs once. */
export const runBulkAction = (input: BulkInput) => staffMutation<BulkResult>("/api/staff/bookings/bulk", "POST", input, { idempotencyKey: crypto.randomUUID() });

export const changeBooking = (row: Pick<BookingRow, "id" | "version">, body: Record<string, unknown>) =>
  staffMutation<unknown>(`/api/staff/appointments/${encodeURIComponent(row.id)}`, "PATCH", { ...body, expectedVersion: row.version });

export function useCancelPresets(enabled: boolean) {
  const query = useQuery({ queryKey: ["staff", "cancel-presets"], enabled, staleTime: 60_000, queryFn: ({ signal }) => staffQuery<CancelPreset[]>("/api/staff/cancel-presets", signal) });
  return { presets: query.data ?? [], loading: query.isPending && enabled, failed: query.isError };
}
