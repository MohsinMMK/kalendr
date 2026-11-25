import type { Metadata } from "next";

import { ReportsWorkspace } from "@/features/clinic/reports-workspace";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return {
    title: labels.reports,
    description: "Bookings, utilisation, no-shows, revenue, customers and sources.",
    robots: { index: false, follow: false },
  };
}

export default async function ReportsPage() {
  await requirePageAccess("reports");
  return <ReportsWorkspace />;
}
