import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  AdminAbuse,
  AdminAuditRow,
  AdminMessageRow,
  OperatorRow,
  AdminSignupDay,
  AdminTenantHealth,
  AdminTenantList,
  AdminWorkerHealth,
  RolloutRow,
} from "@/lib/admin-contracts";
import { staffMutation, staffQuery } from "@/features/clinic/queries/http";

/**
 * The browser side of `/api/admin/*`. Every path lives here so a route that moves is a one-line change.
 * Reads go through react-query; each action is a small function the dialogs call.
 */
export const adminPaths = {
  tenants: "/api/admin/tenants",
  signups: "/api/admin/signups",
  tenant: (id: string) => `/api/admin/tenants/${encodeURIComponent(id)}`,
  pause: (id: string) => `/api/admin/tenants/${encodeURIComponent(id)}/pause`,
  resend: (id: string) => `/api/admin/tenants/${encodeURIComponent(id)}/resend-verification`,
  extendTrial: (id: string) => `/api/admin/tenants/${encodeURIComponent(id)}/extend-trial`,
  changePlan: (id: string) => `/api/admin/tenants/${encodeURIComponent(id)}/change-plan`,
  impersonate: (id: string) => `/api/admin/tenants/${encodeURIComponent(id)}/impersonate`,
  endImpersonation: "/api/admin/impersonation/end",
  messages: "/api/admin/messages",
  worker: "/api/admin/worker",
  retry: "/api/admin/worker/retry",
  abuse: "/api/admin/abuse",
  features: "/api/admin/rollouts",
  audit: "/api/admin/audit",
  operators: "/api/admin/operators",
} as const;

export const adminKeys = {
  all: ["admin"] as const,
  tenants: (search: string, status: string, page: number) => ["admin", "tenants", search, status, page] as const,
  signups: (days: number) => ["admin", "signups", days] as const,
  tenant: (id: string) => ["admin", "tenant", id] as const,
  messages: (q: string) => ["admin", "messages", q] as const,
  worker: () => ["admin", "worker"] as const,
  abuse: () => ["admin", "abuse"] as const,
  features: () => ["admin", "features"] as const,
  audit: (tenantId: string) => ["admin", "audit", tenantId] as const,
  operators: () => ["admin", "operators"] as const,
};

export const workerRefreshMs = 15_000;

export function useTenantList(search: string, status: string, page: number) {
  return useQuery({
    queryKey: adminKeys.tenants(search, status, page),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ status, page: String(page) });
      if (search) params.set("search", search);
      return staffQuery<AdminTenantList>(`${adminPaths.tenants}?${params.toString()}`, signal);
    },
    placeholderData: keepPreviousData,
  });
}

export function useSignups(days: number) {
  return useQuery({
    queryKey: adminKeys.signups(days),
    queryFn: ({ signal }) => staffQuery<AdminSignupDay[]>(`${adminPaths.signups}?days=${days}`, signal),
  });
}

export function useTenantHealth(id: string) {
  return useQuery({ queryKey: adminKeys.tenant(id), queryFn: ({ signal }) => staffQuery<AdminTenantHealth>(adminPaths.tenant(id), signal) });
}

export function useMessageSearch(q: string) {
  return useQuery({
    queryKey: adminKeys.messages(q),
    queryFn: ({ signal }) => staffQuery<AdminMessageRow[]>(`${adminPaths.messages}?id=${encodeURIComponent(q)}`, signal),
    enabled: q.length > 0,
  });
}

export function useWorkerHealth() {
  return useQuery({
    queryKey: adminKeys.worker(),
    queryFn: ({ signal }) => staffQuery<AdminWorkerHealth>(adminPaths.worker, signal),
    refetchInterval: workerRefreshMs,
  });
}

export function useAbuse() {
  return useQuery({ queryKey: adminKeys.abuse(), queryFn: ({ signal }) => staffQuery<AdminAbuse>(adminPaths.abuse, signal) });
}

export function useRollouts() {
  return useQuery({ queryKey: adminKeys.features(), queryFn: ({ signal }) => staffQuery<RolloutRow[]>(adminPaths.features, signal) });
}

export function useAuditEvents(tenantId: string) {
  return useQuery({
    queryKey: adminKeys.audit(tenantId),
    queryFn: ({ signal }) => staffQuery<AdminAuditRow[]>(tenantId ? `${adminPaths.audit}?tenantId=${encodeURIComponent(tenantId)}` : adminPaths.audit, signal),
  });
}

export function useOperators(enabled: boolean) {
  return useQuery({ queryKey: adminKeys.operators(), queryFn: ({ signal }) => staffQuery<OperatorRow[]>(adminPaths.operators, signal), enabled });
}

/** An action that changes something, then refreshes what the screens show. */
export function useAdminAction<Input, Result = unknown>(run: (input: Input) => Promise<Result>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => client.invalidateQueries({ queryKey: adminKeys.all }),
  });
}

export const adminActions = {
  pause: (id: string, body: { paused: boolean; reason: string }) => staffMutation<unknown>(adminPaths.pause(id), "POST", body),
  resend: (id: string, body: { reason: string }) => staffMutation<unknown>(adminPaths.resend(id), "POST", body),
  extendTrial: (id: string, body: { days: number; reason: string }) => staffMutation<unknown>(adminPaths.extendTrial(id), "POST", body),
  changePlan: (id: string, body: { planKey: string; reason: string }) => staffMutation<unknown>(adminPaths.changePlan(id), "POST", body),
  impersonate: (id: string, body: { reason: string; write: boolean }) => staffMutation<unknown>(adminPaths.impersonate(id), "POST", body),
  endImpersonation: () => staffMutation<unknown>(adminPaths.endImpersonation, "POST", {}),
  retry: (body: { eventId: string; reason: string }) => staffMutation<unknown>(adminPaths.retry, "POST", body),
  saveRollout: (body: { featureKey: string; mode: string; percent: number; tenantIds: string[]; reason: string }) => staffMutation<unknown>(adminPaths.features, "PUT", body),
  saveOperator: (body: { email: string; role: string; active: boolean; reason: string }) => staffMutation<unknown>(adminPaths.operators, "PUT", body),
};
