import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AssistantChatLine, AssistantSettingsUpdate, AssistantSettingsView } from "@/lib/assistant-contracts";
import type { HandoffSummary } from "@/server/assistant/handoffs";

import { staffMutation, staffQuery } from "../queries/http";

const keys = {
  settings: ["staff", "assistant", "settings"] as const,
  handoffs: ["staff", "assistant", "handoffs"] as const,
  chat: (id: string) => ["staff", "assistant", "handoffs", id] as const,
};

export function useAssistantSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: ({ signal }) => staffQuery<AssistantSettingsView>("/api/staff/assistant/settings", signal) });
}

export function useSaveAssistantSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AssistantSettingsUpdate) => staffMutation<AssistantSettingsView>("/api/staff/assistant/settings", "PUT", input),
    onSuccess: (saved) => client.setQueryData(keys.settings, saved),
  });
}

export function useHandoffs() {
  return useQuery({ queryKey: keys.handoffs, queryFn: ({ signal }) => staffQuery<{ handoffs: HandoffSummary[] }>("/api/staff/assistant/handoffs", signal), select: (data) => data.handoffs, refetchInterval: 60_000 });
}

export function useHandoffChat(id: string | null) {
  return useQuery({
    queryKey: keys.chat(id ?? "none"), enabled: Boolean(id),
    queryFn: ({ signal }) => staffQuery<{ lines: AssistantChatLine[] }>(`/api/staff/assistant/handoffs?id=${encodeURIComponent(id ?? "")}`, signal),
  });
}

export function useHandoffAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: "hand_back" | "close" }) => staffMutation<{ ok: true }>("/api/staff/assistant/handoffs", "POST", input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.handoffs }),
  });
}

export function useCopilotConfirm() {
  return useMutation({
    mutationFn: (input: { conversationId: string; proposalId: string }) => staffMutation<{ appointmentId: string; summary: string }>("/api/staff/assistant", "PUT", input),
  });
}
