import type { Metadata } from "next";

import { ServicesWorkspace } from "@/features/clinic/services-workspace";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return {
    title: labels.services,
    description: "Everything customers can book, in the order they see it.",
    robots: { index: false, follow: false },
  };
}

export default async function ServicesPage() {
  await requirePageAccess("services");
  return <ServicesWorkspace />;
}
