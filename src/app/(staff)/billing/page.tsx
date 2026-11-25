import type { Metadata } from "next";

import { BillingWorkspace } from "@/features/clinic/billing-workspace";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return {
    title: labels.billing,
    description: "Invoices, receipts, day end and GST settings.",
    robots: { index: false, follow: false },
  };
}

export default async function BillingPage() {
  await requirePageAccess("billing");
  return <BillingWorkspace />;
}
