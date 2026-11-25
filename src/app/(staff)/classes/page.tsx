import type { Metadata } from "next";

import { ClassesWorkspace } from "@/features/clinic/classes-workspace";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return {
    title: labels.classes,
    description: "Group sessions, seats, rosters and waiting lists.",
  };
}

export default async function ClassesPage() {
  await requirePageAccess("classes");
  return <ClassesWorkspace />;
}
