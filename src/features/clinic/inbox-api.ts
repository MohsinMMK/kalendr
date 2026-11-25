"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ChannelSettings, ChannelSettingsInput, InboxFilter, ReplyInput, ThreadDetail, ThreadSummary } from "@/lib/inbox-contracts";

import { readApiDetails, readApiError, StaffApiError, staffQuery } from "./queries/http";

/**
 * Sends a change and resolves when the server accepts it. The shared staffMutation only does POST and
 * insists on a `data` body; the inbox also needs PUT and a bare "read" call.
 */
async function send(path: string, method: "POST" | "PUT", body?: unknown, idempotencyKey?: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.ok) return;
  const result: unknown = await response.json().catch(() => null);
  const code = typeof result === "object" && result !== null && "error" in result && typeof result.error === "object" && result.error !== null && "code" in result.error && typeof result.error.code === "string" ? result.error.code : "unknown";
  throw new StaffApiError(readApiError(result, "The change could not be saved."), response.status, code, {}, readApiDetails(result));
}

/** How often the open Inbox asks again. Live updates (feature 32) will replace this. */
export const inboxPollMs = 10_000;

// Under ["staff"] so signing out clears them with everything else.
export const inboxKeys = {
  all: ["staff", "inbox"] as const,
  list: (filter: InboxFilter) => ["staff", "inbox", "threads", filter] as const,
  thread: (id: string) => ["staff", "inbox", "thread", id] as const,
  channels: () => ["staff", "inbox", "channels"] as const,
};

export function useThreads(filter: InboxFilter, enabled: boolean) {
  return useQuery({
    queryKey: inboxKeys.list(filter),
    queryFn: ({ signal }) => staffQuery<ThreadSummary[]>(`/api/staff/threads?filter=${filter}`, signal),
    refetchInterval: inboxPollMs,
    enabled,
  });
}

export function useThread(id: string | null) {
  return useQuery({
    queryKey: inboxKeys.thread(id ?? "none"),
    queryFn: ({ signal }) => staffQuery<ThreadDetail>(`/api/staff/threads/${encodeURIComponent(id ?? "")}`, signal),
    refetchInterval: inboxPollMs,
    enabled: id !== null,
  });
}

/** Opening a thread clears its unread count on the server; the lists then show it. */
export function useMarkRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => send(`/api/staff/threads/${encodeURIComponent(id)}/read`, "POST"),
    onSettled: () => client.invalidateQueries({ queryKey: [...inboxKeys.all, "threads"] }),
  });
}

export function useSendReply(threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ input, key }: { input: ReplyInput; key: string }) =>
      send(`/api/staff/threads/${encodeURIComponent(threadId)}/messages`, "POST", input, key),
    onSettled: () => client.invalidateQueries({ queryKey: inboxKeys.all }),
  });
}

export function useAssign(threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string | null) => send(`/api/staff/threads/${encodeURIComponent(threadId)}/assign`, "PUT", { userId }),
    onSettled: () => client.invalidateQueries({ queryKey: inboxKeys.all }),
  });
}

export function useChannelSettings(enabled: boolean) {
  return useQuery({
    queryKey: inboxKeys.channels(),
    queryFn: ({ signal }) => staffQuery<ChannelSettings>("/api/staff/channels", signal),
    enabled,
  });
}

export function useSaveChannelSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ChannelSettingsInput) => send("/api/staff/channels", "PUT", input),
    // Flip the switch at once; roll back if the server says no.
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: inboxKeys.channels() });
      const before = client.getQueryData<ChannelSettings>(inboxKeys.channels());
      if (before) {
        client.setQueryData<ChannelSettings>(inboxKeys.channels(), {
          whatsapp: { ...before.whatsapp, enabled: input.whatsappEnabled ?? before.whatsapp.enabled },
          sms: { ...before.sms, enabled: input.smsEnabled ?? before.sms.enabled },
        });
      }
      return { before };
    },
    onError: (_error, _input, context) => {
      if (context?.before) client.setQueryData(inboxKeys.channels(), context.before);
    },
    onSettled: () => client.invalidateQueries({ queryKey: inboxKeys.channels() }),
  });
}

/** How many conversations have something unread; the number on the Inbox tab. */
export function useUnreadThreadCount(enabled: boolean): number {
  return useThreads("unread", enabled).data?.length ?? 0;
}
