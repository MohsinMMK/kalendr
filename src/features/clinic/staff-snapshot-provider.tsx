"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { useTerms } from "@/features/terms/business-profile-context";
import type { StaffRole } from "@/lib/permissions";
import type { StaffSnapshot } from "@/lib/staff-snapshot";

import { useLiveEvents, type LiveChange } from "./use-live-events";
import { isDataResponse, readApiError } from "./queries/http";
import { staffKeys } from "./queries/keys";
import { isAuthError, useSnapshotQuery } from "./queries/snapshot";

export { staffMutation, staffQuery, staffUpload } from "./queries/http";

interface SnapshotState {
  snapshot: StaffSnapshot | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  role: StaffRole;
  /** Goes up when another screen changes the handover notes, which load on their own. */
  notesVersion: number;
}

const StaffSnapshotContext = createContext<SnapshotState | null>(null);

/**
 * The staff snapshot, read through the react-query cache. Screens that have moved to the query layer
 * (`./queries`) read and change the cache directly; the rest keep using this provider unchanged.
 */
export function StaffSnapshotProvider({ children, role }: { children: ReactNode; role: StaffRole }) {
  const t = useTerms();
  const client = useQueryClient();
  const query = useSnapshotQuery();
  const signedOut = isAuthError(query.error);
  const snapshot = signedOut ? null : query.data ?? null;
  const error = query.error ? (query.error instanceof Error && query.error.message) || `${t.Business} data could not be loaded.` : "";
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: staffKeys.snapshot() });
  }, [client]);
  const loading = query.isFetching;
  // The page arrives with the snapshot already in it, so the browser would never ask for it. The service worker
  // keeps the last snapshot it saw so the schedule opens offline (public/sw.js), so when one is in charge of the
  // page, ask once in the background, after the first screen is up.
  const { refetch } = query;
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.serviceWorker?.controller) void refetch();
  }, [refetch]);
  const [notesVersion, setNotesVersion] = useState(0);
  // Another screen booked, checked in, sent something or left a note: refetch what changed.
  const onLiveChange = useCallback((change: LiveChange) => {
    const all = change === "all";
    // An alert only changes the bell, which listens for itself; it must not refetch the whole diary.
    if (all || [...change].some((kind) => kind !== "note" && kind !== "notification")) void refresh();
    if (all || change.has("note")) setNotesVersion((current) => current + 1);
    if (all || change.has("notification")) void client.invalidateQueries({ queryKey: staffKeys.notifications() });
  }, [refresh, client]);
  useLiveEvents(onLiveChange);
  const value = useMemo(() => ({ snapshot, loading, error, refresh, role, notesVersion }), [snapshot, loading, error, refresh, role, notesVersion]);
  return <StaffSnapshotContext.Provider value={value}>{children}</StaffSnapshotContext.Provider>;
}

export function useStaffSnapshot(): SnapshotState {
  const context = useContext(StaffSnapshotContext);
  if (!context) throw new Error("StaffSnapshotProvider is required for the database workspace.");
  return context;
}

export function useOptionalStaffSnapshot(): SnapshotState | null {
  return useContext(StaffSnapshotContext);
}

export async function fetchAvailabilitySlots(query: {
  clinicSlug: string;
  locationId: string;
  serviceId: string;
  practitionerId?: string;
  from: string;
  to: string;
  /** Staff-only: openings from 15 minutes ago, ignoring the online lead time. */
  walkIn?: boolean;
  /** Moving a booked visit: its own length in minutes, kept even if the service has other lengths now. */
  keepDurationMinutes?: number;
}, signal?: AbortSignal): Promise<import("@/lib/domain").TimeSlot[]> {
  const params = new URLSearchParams({
    clinicSlug: query.clinicSlug,
    locationId: query.locationId,
    serviceId: query.serviceId,
    practitionerId: query.practitionerId || "first_available",
    from: query.from,
    to: query.to,
  });
  if (query.walkIn) params.set("walkIn", "1");
  if (query.keepDurationMinutes) {
    params.set("durationMinutes", String(query.keepDurationMinutes));
    params.set("keepLength", "1");
  }
  const response = await fetch(`${query.walkIn ? "/api/staff/availability" : "/api/public/availability"}?${params.toString()}`, { cache: "no-store", signal });
  const result: unknown = await response.json();
  if (!response.ok || !isSlotsResponse(result)) {
    throw new Error(readApiError(result, "Compatible openings could not be loaded."));
  }
  return result.data.slots;
}

function isSlotsResponse(value: unknown): value is { data: { slots: import("@/lib/domain").TimeSlot[] } } {
  if (!isDataResponse(value) || typeof value.data !== "object" || value.data === null || !("slots" in value.data)) return false;
  return Array.isArray(value.data.slots);
}
