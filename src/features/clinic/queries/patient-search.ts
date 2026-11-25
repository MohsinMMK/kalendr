import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";

import { staffKeys } from "./keys";
import { staffQuery } from "./http";

const searchResultSchema = z.object({
  patients: z.array(z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    phone: z.string(),
    email: z.string().optional().default(""),
  })),
  truncated: z.boolean().optional().default(false),
});

export type PatientSearchResult = z.infer<typeof searchResultSchema>;

export async function searchPatients(query: string, signal?: AbortSignal): Promise<PatientSearchResult> {
  const params = new URLSearchParams({ q: query, limit: "8" });
  return searchResultSchema.parse(await staffQuery<unknown>(`/api/staff/patients?${params.toString()}`, signal));
}

/** The value, but only after it has stopped changing for `delayMs`. Keeps a server search from firing on every key. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export const patientSearchDelayMs = 250;
/** Two characters is enough to narrow a list; a single letter matches half the directory. */
export const patientSearchMinLength = 2;

/** Customers matching a name, phone number or email, searched on the server so every customer is reachable. */
export function usePatientSearch(rawQuery: string, enabled: boolean) {
  const query = useDebouncedValue(rawQuery.trim(), patientSearchDelayMs);
  const active = enabled && query.length >= patientSearchMinLength;
  const result = useQuery({
    queryKey: staffKeys.patientSearch(query),
    queryFn: ({ signal }) => searchPatients(query, signal),
    enabled: active,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  return {
    patients: active ? result.data?.patients ?? [] : [],
    truncated: active && Boolean(result.data?.truncated),
    // Typing ahead of the debounce also counts as searching, so "Nothing found" never flashes in between.
    searching: enabled && rawQuery.trim().length >= patientSearchMinLength && (query !== rawQuery.trim() || result.isFetching),
    failed: active && result.isError,
    retry: () => { void result.refetch(); },
  };
}
