import type { Metadata } from "next";

import { ScheduleWorkspace } from "@/features/clinic/schedule-workspace";
import { currentStaffWords } from "@/server/business-profile";
import { requireStaffPageContext } from "@/server/staff-context";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  const t = await currentStaffWords();
  return {
    title: labels.schedule,
    description: `${t.Business} ${t.appointment} schedule.`,
  };
}

export default async function SchedulePage() {
  await requireStaffPageContext();
  // The view, date, filters and open appointment are read from the address by the screen itself.
  return <ScheduleWorkspace />;
}
