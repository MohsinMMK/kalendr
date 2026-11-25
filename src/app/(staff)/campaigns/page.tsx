import type { Metadata } from "next";

import { CampaignsWorkspace } from "@/features/clinic/campaigns-workspace";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return {
    title: labels.campaigns,
    description: "Recall, birthday and win-back messages, and one-off offers.",
    robots: { index: false, follow: false },
  };
}

export default async function CampaignsPage() {
  await requirePageAccess("campaigns");
  return <CampaignsWorkspace />;
}
