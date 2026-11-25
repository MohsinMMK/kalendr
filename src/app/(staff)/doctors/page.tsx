import type { Metadata } from "next";

import { DoctorsWorkspace } from "@/features/clinic/doctors-workspace";
import { currentStaffWords } from "@/server/business-profile";
import { requireStaffPageContext } from "@/server/staff-context";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  const t = await currentStaffWords();
  return {
    title: labels.doctors,
    description: `${t.Practitioner} profiles, services and working hours.`,
  };
}

export default async function DoctorsPage() {
  await requireStaffPageContext();
  return <DoctorsWorkspace />;
}
