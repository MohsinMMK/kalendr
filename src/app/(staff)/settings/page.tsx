import type { Metadata } from "next";

import { SettingsWorkspace } from "@/features/clinic/settings-workspace";
import { currentStaffWords } from "@/server/business-profile";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const [t, labels] = await Promise.all([currentStaffWords(), currentStaffNavLabels()]);
  return {
    // Renaming Settings renames its tab too; otherwise it keeps the business word ("Salon settings").
    title: labels.settings === "Settings" ? `${t.Business} settings` : labels.settings,
    description: `${t.Customer} booking page, hours, team, and later reminder and website setup.`,
  };
}

export default async function SettingsPage() {
  await requirePageAccess("settings");
  // A full page with its own sidebar (the staff frame swaps it in under /settings); the section is in the address.
  return <SettingsWorkspace />;
}
