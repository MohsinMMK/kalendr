import { useQuery } from "@tanstack/react-query";

import type { RetentionSettings } from "@/server/privacy/retention-settings";
import type { StaffRequestView } from "@/server/privacy/requests";
import type { ProcessingSummary } from "@/server/privacy/summary";

import { staffKeys } from "./keys";
import { staffMutation, staffQuery } from "./http";

export type { ProcessingSummary, RetentionSettings, StaffRequestView };

export type RequestStatusFilter = "open" | "overdue" | "closed" | "all";
export type RequestTypeFilter = "all" | "export" | "erasure" | "correction";

export const privacyKeys = {
  requests: (status: RequestStatusFilter, type: RequestTypeFilter) => [...staffKeys.all, "privacy", "requests", status, type] as const,
  retention: () => [...staffKeys.all, "privacy", "retention"] as const,
  summary: () => [...staffKeys.all, "privacy", "summary"] as const,
};

export interface PrivacyRequestList {
  requests: StaffRequestView[];
  counts: { open: number; overdue: number };
}

export function requestListPath(status: RequestStatusFilter, type: RequestTypeFilter): string {
  const params = new URLSearchParams({ status: status === "overdue" ? "open" : status });
  if (status === "overdue") params.set("overdue", "true");
  if (type !== "all") params.set("type", type);
  return `/api/staff/privacy/requests?${params.toString()}`;
}

export function usePrivacyRequests(status: RequestStatusFilter, type: RequestTypeFilter, enabled: boolean) {
  return useQuery({
    queryKey: privacyKeys.requests(status, type),
    queryFn: ({ signal }) => staffQuery<PrivacyRequestList>(requestListPath(status, type), signal),
    enabled,
  });
}

export function useRetentionSettings(enabled: boolean) {
  return useQuery({ queryKey: privacyKeys.retention(), queryFn: ({ signal }) => staffQuery<RetentionSettings>("/api/staff/privacy/retention", signal), enabled });
}

export function useProcessingSummary(enabled: boolean) {
  return useQuery({ queryKey: privacyKeys.summary(), queryFn: ({ signal }) => staffQuery<ProcessingSummary>("/api/staff/privacy/summary", signal), enabled });
}

export function saveRetention(policies: { dataKind: string; keepDays: number; action: string }[]) {
  return staffMutation<RetentionSettings>("/api/staff/privacy/retention", "PUT", { policies });
}

export function decideRequestCall(id: string, body: { decision: "approve" | "refuse"; reason: string; note?: string; version: number }, idempotencyKey: string) {
  return staffMutation<StaffRequestView>(`/api/staff/privacy/requests/${encodeURIComponent(id)}`, "PATCH", body, { idempotencyKey });
}
