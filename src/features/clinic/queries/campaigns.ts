import { useQuery } from "@tanstack/react-query";

import type { AudiencePreview, CampaignChannelStatus, CampaignPreview, CampaignPreset, CampaignSummary, WhatsAppTemplateStatus } from "@/lib/campaign-contracts";
import type { SegmentSummary } from "@/lib/segment-filter";

import { staffQuery } from "./http";
import { staffKeys } from "./keys";

export interface CampaignOptions {
  presets: CampaignPreset[];
  templates: WhatsAppTemplateStatus[];
  channels: CampaignChannelStatus[];
}

export const campaignKeys = {
  all: () => [...staffKeys.all, "campaigns"] as const,
  list: () => [...staffKeys.all, "campaigns", "list"] as const,
  options: () => [...staffKeys.all, "campaigns", "options"] as const,
  audience: (id: string) => [...staffKeys.all, "campaigns", "audience", id] as const,
  preview: (id: string) => [...staffKeys.all, "campaigns", "preview", id] as const,
  segments: () => [...staffKeys.all, "segments"] as const,
};

/** GET /api/staff/campaigns: every campaign with its results. */
export function useCampaigns(enabled = true) {
  return useQuery({ queryKey: campaignKeys.list(), queryFn: ({ signal }) => staffQuery<CampaignSummary[]>("/api/staff/campaigns", signal), enabled });
}

/** GET /api/staff/campaigns/options: the ready-made campaigns, approved WhatsApp messages and which channels are connected. */
export function useCampaignOptions(enabled = true) {
  return useQuery({ queryKey: campaignKeys.options(), queryFn: ({ signal }) => staffQuery<CampaignOptions>("/api/staff/campaigns/options", signal), enabled });
}

/** Who a campaign reaches right now. Read again whenever the campaign changes (its version is part of the key). */
export function useCampaignAudience(id: string | null, version: number) {
  return useQuery({
    queryKey: [...campaignKeys.audience(id ?? ""), version],
    queryFn: ({ signal }) => staffQuery<AudiencePreview>(`/api/staff/campaigns/${encodeURIComponent(id ?? "")}/audience`, signal),
    enabled: Boolean(id),
  });
}

export function useCampaignPreview(id: string | null, version: number) {
  return useQuery({
    queryKey: [...campaignKeys.preview(id ?? ""), version],
    queryFn: ({ signal }) => staffQuery<CampaignPreview>(`/api/staff/campaigns/${encodeURIComponent(id ?? "")}/preview`, signal),
    enabled: Boolean(id),
  });
}

export function useSegments(enabled = true) {
  return useQuery({ queryKey: campaignKeys.segments(), queryFn: ({ signal }) => staffQuery<SegmentSummary[]>("/api/staff/segments", signal), enabled });
}
