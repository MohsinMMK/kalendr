import type { Metadata } from "next";

import { DashboardWorkspace } from "@/features/clinic/dashboard-workspace";
import { currentStaffWords } from "@/server/business-profile";
import { requireStaffPageContext } from "@/server/staff-context";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  const t = await currentStaffWords();
  return {
    title: labels.dashboard,
    description: `Today's ${t.business} arrivals, requests, and waiting ${t.appointments}.`,
  };
}

export default async function DashboardPage() {
  await requireStaffPageContext();
  return <DashboardWorkspace />;
}
