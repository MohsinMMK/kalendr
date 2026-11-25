"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { StaffApiError, readApiError, readFieldErrors, staffMutation, staffQuery } from "../queries/http";
import { useStepUp } from "../step-up-dialog";
import type { ApiKeyView, CreateApiKeyInput, CreatedApiKey } from "@/server/api-keys-contracts";
import type { WebhookDelivery, WebhookEndpoint } from "./webhook-types";

// Under ["staff"] so signing out clears them with everything else.
export const developerKeys = {
  keys: ["staff", "developers", "keys"] as const,
  webhooks: ["staff", "developers", "webhooks"] as const,
  deliveries: (endpointId: string) => ["staff", "developers", "webhooks", endpointId, "deliveries"] as const,
};

/** A change that may answer with no body (a delete, a queued resend). Failures read like the other staff calls. */
async function send<T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T | null> {
  const response = await fetch(path, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let result: unknown = null;
  try { result = text ? JSON.parse(text) : null; } catch { result = null; }
  if (!response.ok) {
    const code = typeof result === "object" && result !== null && "error" in result && typeof result.error === "object" && result.error !== null && "code" in result.error && typeof result.error.code === "string" ? result.error.code : "unknown";
    throw new StaffApiError(readApiError(result, "The change could not be saved."), response.status, code, readFieldErrors(result));
  }
  if (typeof result === "object" && result !== null && "data" in result) return result.data as T;
  return null;
}

/* ------------------------------------------------------------------ API keys */

export function useApiKeys(enabled: boolean) {
  return useQuery({ queryKey: developerKeys.keys, queryFn: ({ signal }) => staffQuery<{ keys: ApiKeyView[] }>("/api/staff/api-keys", signal), enabled });
}

export function useCreateApiKey() {
  const client = useQueryClient();
  const { runWithStepUp } = useStepUp();
  return useMutation({
    mutationFn: (input: CreateApiKeyInput) => runWithStepUp(() => staffMutation<CreatedApiKey>("/api/staff/api-keys", "POST", input)),
    onSuccess: () => client.invalidateQueries({ queryKey: developerKeys.keys }),
  });
}

export function useRevokeApiKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => send(`/api/staff/api-keys/${encodeURIComponent(id)}/revoke`, "POST", {}),
    onSuccess: () => client.invalidateQueries({ queryKey: developerKeys.keys }),
  });
}

/* ------------------------------------------------------------------ webhooks */

export interface WebhookFormValues { url: string; description: string; events: string[] }

export function useWebhooks(enabled: boolean) {
  return useQuery({ queryKey: developerKeys.webhooks, queryFn: ({ signal }) => staffQuery<{ endpoints: WebhookEndpoint[] }>("/api/staff/webhooks", signal), enabled });
}

export function useSaveWebhook() {
  const client = useQueryClient();
  const { runWithStepUp } = useStepUp();
  return useMutation({
    mutationFn: ({ endpoint, values }: { endpoint: WebhookEndpoint | null; values: WebhookFormValues }) => runWithStepUp(async () => {
      const description = values.description.trim();
      if (!endpoint) return send<{ endpoint: WebhookEndpoint; secret: string }>("/api/staff/webhooks", "POST", { url: values.url.trim(), description: description || null, events: values.events });
      return send<{ endpoint: WebhookEndpoint }>(`/api/staff/webhooks/${encodeURIComponent(endpoint.id)}`, "PATCH", { url: values.url.trim(), description: description || null, events: values.events, expectedVersion: endpoint.version });
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: developerKeys.webhooks }),
  });
}

export function useSetWebhookStatus() {
  const client = useQueryClient();
  const { runWithStepUp } = useStepUp();
  return useMutation({
    mutationFn: ({ endpoint, status }: { endpoint: WebhookEndpoint; status: "active" | "disabled" }) =>
      runWithStepUp(() => send(`/api/staff/webhooks/${encodeURIComponent(endpoint.id)}`, "PATCH", { status, expectedVersion: endpoint.version })),
    onSettled: () => client.invalidateQueries({ queryKey: developerKeys.webhooks }),
  });
}

export function useDeleteWebhook() {
  const client = useQueryClient();
  const { runWithStepUp } = useStepUp();
  return useMutation({
    mutationFn: (id: string) => runWithStepUp(() => send(`/api/staff/webhooks/${encodeURIComponent(id)}`, "DELETE")),
    onSuccess: () => client.invalidateQueries({ queryKey: developerKeys.webhooks }),
  });
}

export function useRotateWebhookSecret() {
  const client = useQueryClient();
  const { runWithStepUp } = useStepUp();
  return useMutation({
    mutationFn: (id: string) => runWithStepUp(() => send<{ secret: string }>(`/api/staff/webhooks/${encodeURIComponent(id)}/rotate-secret`, "POST", {})),
    onSuccess: () => client.invalidateQueries({ queryKey: developerKeys.webhooks }),
  });
}

export function useSendTestEvent() {
  const client = useQueryClient();
  const { runWithStepUp } = useStepUp();
  return useMutation({
    mutationFn: (id: string) => runWithStepUp(() => send<{ deliveryId: string }>(`/api/staff/webhooks/${encodeURIComponent(id)}/test`, "POST", {})),
    onSuccess: (_data, id) => client.invalidateQueries({ queryKey: developerKeys.deliveries(id) }),
  });
}

export function useDeliveries(endpointId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: developerKeys.deliveries(endpointId),
    queryFn: ({ pageParam, signal }) => staffQuery<{ deliveries: WebhookDelivery[]; nextCursor: string | null }>(
      `/api/staff/webhooks/${encodeURIComponent(endpointId)}/deliveries?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, signal),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useResendDelivery(endpointId: string) {
  const client = useQueryClient();
  const { runWithStepUp } = useStepUp();
  return useMutation({
    mutationFn: (deliveryId: string) => runWithStepUp(() => send(`/api/staff/webhooks/deliveries/${encodeURIComponent(deliveryId)}/resend`, "POST", {})),
    onSuccess: () => client.invalidateQueries({ queryKey: developerKeys.deliveries(endpointId) }),
  });
}
