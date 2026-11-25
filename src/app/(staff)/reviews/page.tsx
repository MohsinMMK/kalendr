import type { Metadata } from "next";

import { MovedSettingsPage } from "@/features/clinic/moved-settings-page";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return { title: labels["reviews"], description: "What customers say, and which reviews show on the booking page.", robots: { index: false, follow: false } };
}

export default async function Page() {
  await requirePageAccess("reviews");
  return <MovedSettingsPage page="reviews" />;
}
