"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AppCard, AppDetail } from "@/lib/apps/catalog";
import type { OAuthClientView, OAuthGrantView } from "@/lib/oauth";

import { staffMutation, staffQuery } from "../queries/http";
import { useStepUp } from "../step-up-dialog";

// Under ["staff"] so signing out clears them with everything else.
export const appKeys = {
  all: ["staff", "apps"] as const,
  list: ["staff", "apps", "list"] as const,
  detail: (key: string) => ["staff", "apps", "detail", key] as const,
  grants: ["staff", "apps", "grants"] as const,
  clients: ["staff", "apps", "clients"] as const,
};

/** An app being installed or removed changes in the worker, so the list is re-read while one is in flight. */
export function useApps() {
  return useQuery({
    queryKey: appKeys.list,
    queryFn: ({ signal }) => staffQuery<{ apps: AppCard[] }>("/api/staff/apps", signal),
    refetchInterval: (query) => (query.state.data?.apps.some((app) => app.state === "uninstalling") ? 3_000 : false),
  });
}

export function useAppDetail(key: string | null) {
  return useQuery({
    queryKey: appKeys.detail(key ?? ""),
    queryFn: ({ signal }) => staffQuery<AppDetail>(`/api/staff/apps/${encodeURIComponent(key ?? "")}`, signal),
    enabled: key !== null,
    // The check after install lands a few seconds later; keep reading until the log has an answer.
    refetchInterval: (query) => (query.state.data && query.state.data.events.length === 0 && query.state.data.state !== "available" ? 3_000 : false),
  });
}

function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: appKeys.all });
}

export function useInstallApp(key: string) {
  const refresh = useRefresh();
  const { runWithStepUp } = useStepUp();
  return useMutation({
    mutationFn: (input: { credentials: Record<string, string>; settings: Record<string, unknown> }) =>
      runWithStepUp(() => staffMutation<AppDetail>(`/api/staff/apps/${encodeURIComponent(key)}/install`, "POST", input)),
    onSuccess: refresh,
  });
}

export function useSaveAppSettings(key: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: { settings: Record<string, unknown>; expectedVersion: number }) =>
      staffMutation<AppDetail>(`/api/staff/apps/${encodeURIComponent(key)}`, "PATCH", input),
    onSuccess: refresh,
  });
}

export function useReplaceCredentials(key: string) {
  const refresh = useRefresh();
  const { runWithStepUp } = useStepUp();
  return useMutation({
    mutationFn: (input: { credentials: Record<string, string>; expectedVersion: number }) =>
      runWithStepUp(() => staffMutation<AppDetail>(`/api/staff/apps/${encodeURIComponent(key)}/credentials`, "PUT", input)),
    onSuccess: refresh,
  });
}

export function useSetAppStatus(key: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: { status: "active" | "paused"; expectedVersion: number }) =>
      staffMutation<AppDetail>(`/api/staff/apps/${encodeURIComponent(key)}/status`, "POST", input),
    onSuccess: refresh,
  });
}

export function useCheckApp(key: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => staffMutation<{ queued: true }>(`/api/staff/apps/${encodeURIComponent(key)}/check`, "POST", {}),
    onSuccess: refresh,
  });
}

export function useUninstallApp(key: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => staffMutation<{ removing: true }>(`/api/staff/apps/${encodeURIComponent(key)}`, "DELETE", {}),
    onSuccess: refresh,
  });
}

export type GrantRow = OAuthGrantView & { mine: boolean };

export function useGrants() {
  return useQuery({ queryKey: appKeys.grants, queryFn: ({ signal }) => staffQuery<{ grants: GrantRow[] }>("/api/staff/oauth/grants", signal) });
}

export function useRevokeGrant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => staffMutation(`/api/staff/oauth/grants/${encodeURIComponent(id)}/revoke`, "POST", {}),
    onSuccess: () => client.invalidateQueries({ queryKey: appKeys.grants }),
  });
}

export function useClients(enabled: boolean) {
  return useQuery({ queryKey: appKeys.clients, enabled, queryFn: ({ signal }) => staffQuery<{ clients: OAuthClientView[] }>("/api/staff/oauth/clients", signal) });
}

export function useCreateClient() {
  const client = useQueryClient();
  const { runWithStepUp } = useStepUp();
  return useMutation({
    mutationFn: (input: { name: string; redirectUris: string[]; scopes: string[] }) =>
      runWithStepUp(() => staffMutation<{ client: OAuthClientView; secret: string }>("/api/staff/oauth/clients", "POST", input)),
    onSuccess: () => client.invalidateQueries({ queryKey: appKeys.clients }),
  });
}

export function useRevokeClient() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => staffMutation(`/api/staff/oauth/clients/${encodeURIComponent(id)}/revoke`, "POST", {}),
    onSuccess: () => client.invalidateQueries({ queryKey: appKeys.all }),
  });
}
