import type { Metadata } from "next";

import { PatientsWorkspace } from "@/features/clinic/patients-workspace";
import { currentStaffWords } from "@/server/business-profile";
import { requireStaffPageContext } from "@/server/staff-context";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  const t = await currentStaffWords();
  return {
    title: labels.patients,
    description: `${t.Business} scheduling contacts and ${t.appointment} history.`,
  };
}

export default async function PatientsPage() {
  await requireStaffPageContext();
  return <PatientsWorkspace />;
}
