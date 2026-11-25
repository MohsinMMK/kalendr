"use client";

import { StatusBadge } from "@/components/status-badge";
import { StaffApiError } from "./queries/http";
import { campaignChannelLabels, campaignStatusLabels, pausedReasonText, type CampaignChannel, type CampaignStatus, type CampaignSummary } from "@/lib/campaign-contracts";

const tones: Record<CampaignStatus, "success" | "attention" | "neutral" | "danger" | "info"> = {
  draft: "neutral", active: "success", paused: "attention", sending: "info", completed: "neutral", cancelled: "neutral",
};

export function CampaignStatusBadge({ campaign }: { campaign: Pick<CampaignSummary, "status" | "pausedReason"> }) {
  const text = campaign.status === "paused" && campaign.pausedReason ? "Paused by itself" : campaignStatusLabels[campaign.status];
  return <StatusBadge tone={tones[campaign.status]}>{text}</StatusBadge>;
}

export const channelLabel = (channel: CampaignChannel) => campaignChannelLabels[channel];

export function kindLabel(campaign: Pick<CampaignSummary, "kind" | "ruleType">): string {
  if (campaign.kind === "one_off") return "One-off";
  return "Automated";
}

export function pausedText(campaign: Pick<CampaignSummary, "pausedReason">): string | null {
  return campaign.pausedReason ? pausedReasonText[campaign.pausedReason] : null;
}

/** A refusal in words the owner can act on. A stale version says to reload; every other code already carries its own plain sentence. */
export function campaignErrorText(cause: unknown, fallback: string): string {
  if (cause instanceof StaffApiError) {
    if (cause.code === "version_conflict") return "Someone else changed this campaign. Close it and open it again to see the latest.";
    return cause.message;
  }
  return cause instanceof Error ? cause.message : fallback;
}

export function isPlanLimit(cause: unknown): boolean {
  return cause instanceof StaffApiError && cause.code === "plan_limit";
}
