import type { Metadata } from "next";

import { ImportWorkspace } from "@/features/clinic/import-workspace";
import { currentStaffWords } from "@/server/business-profile";
import { requirePageAccess } from "@/server/staff-page-guard";

export async function generateMetadata(): Promise<Metadata> {
  const t = await currentStaffWords();
  return {
    title: "Import data",
    description: `Bring ${t.customers}, ${t.services} and ${t.appointments} in from a spreadsheet.`,
  };
}

export default async function ImportPage() {
  await requirePageAccess("settings-import");
  return <ImportWorkspace />;
}
