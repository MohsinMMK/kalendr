import type { Metadata } from "next";

import { FollowUpsWorkspace } from "@/features/clinic/follow-ups-workspace";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return {
    title: labels["follow-ups"],
    description: "Waitlist offers and scheduling recall queues.",
  };
}

export default async function FollowUpsPage() {
  await requirePageAccess("follow-ups");
  return <FollowUpsWorkspace />;
}
