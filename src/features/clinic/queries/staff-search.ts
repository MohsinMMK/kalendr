import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { SEARCH_MIN_LENGTH, normaliseSearchQuery, staffSearchResultSchema, type SearchHit, type StaffSearchResult } from "@/lib/search";

import { staffQuery } from "./http";
import { staffKeys } from "./keys";
import { useDebouncedValue } from "./patient-search";

export const staffSearchDelayMs = 200;

export async function searchEverything(query: string, signal?: AbortSignal): Promise<StaffSearchResult> {
  const params = new URLSearchParams({ q: query, limit: "5" });
  return staffSearchResultSchema.parse(await staffQuery<unknown>(`/api/staff/search?${params.toString()}`, signal));
}

/**
 * Customers, appointments, services, team members, invoices and campaigns matching what was typed, found on the server so
 * everything is reachable and only what this person's role may open comes back. Waits for typing to pause first.
 */
export function useStaffSearch(rawQuery: string, enabled: boolean) {
  const typed = normaliseSearchQuery(rawQuery);
  const query = useDebouncedValue(typed, staffSearchDelayMs);
  const active = enabled && query.length >= SEARCH_MIN_LENGTH;
  const result = useQuery({
    queryKey: staffKeys.staffSearch(query),
    queryFn: ({ signal }) => searchEverything(query, signal),
    enabled: active,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const hits: SearchHit[] = active ? result.data?.hits ?? [] : [];
  return {
    hits,
    // Typing ahead of the pause also counts as searching, so "Nothing found" never flashes in between.
    searching: enabled && typed.length >= SEARCH_MIN_LENGTH && (query !== typed || result.isFetching),
    failed: active && result.isError,
    retry: () => { void result.refetch(); },
  };
}
