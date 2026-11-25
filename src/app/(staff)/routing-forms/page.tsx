import type { Metadata } from "next";

import { RoutingFormsWorkspace } from "@/features/clinic/routing-forms/routing-forms-workspace";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return {
    title: labels["routing-forms"],
    description: "A few questions that send each customer to the right service and the right person.",
    robots: { index: false, follow: false },
  };
}

export default async function RoutingFormsPage() {
  await requirePageAccess("routing-forms");
  return <RoutingFormsWorkspace />;
}
