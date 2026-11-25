import type { Metadata } from "next";

import { OffersWorkspace } from "@/features/clinic/offers-workspace";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return {
    title: labels.offers,
    description: "Packages, memberships and discount codes.",
    robots: { index: false, follow: false },
  };
}

export default async function OffersPage() {
  await requirePageAccess("offers");
  return <OffersWorkspace />;
}
