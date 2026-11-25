import { useQuery } from "@tanstack/react-query";

import type { StaffSnapshot } from "@/lib/staff-snapshot";

import { noteResponse } from "@/features/app-support/offline-status";
import { staffKeys } from "./keys";
import { isDataResponse, readApiError, StaffApiError } from "./http";

function isSnapshot(value: unknown): value is StaffSnapshot {
  return typeof value === "object" && value !== null && "catalog" in value && "patients" in value && "appointments" in value;
}

export async function fetchSnapshot(signal?: AbortSignal): Promise<StaffSnapshot> {
  const response = await fetch("/api/staff/snapshot", { cache: "no-store", signal });
  // A copy the service worker kept (the network is down) says when it was saved; the banner shows that time.
  noteResponse(response);
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok || !isDataResponse(result) || !isSnapshot(result.data)) {
    throw new StaffApiError(readApiError(result, "The data could not be loaded."), response.status);
  }
  return result.data;
}

/** Signed out or not allowed: retrying will not help. */
export function isAuthError(error: unknown): boolean {
  return error instanceof StaffApiError && (error.status === 401 || error.status === 403);
}

export function useSnapshotQuery(enabled = true) {
  return useQuery({
    queryKey: staffKeys.snapshot(),
    queryFn: ({ signal }) => fetchSnapshot(signal),
    enabled,
  });
}
