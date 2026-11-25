import type { Metadata } from "next";

import { InvoicePage } from "@/features/billing/invoice-view";
import { requirePageAccess } from "@/server/staff-page-guard";

export const metadata: Metadata = {
  title: "Invoice",
  // An invoice carries the business's GSTIN and is for its owner, not for a search engine.
  robots: { index: false, follow: false },
};

export default async function BillingInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const [staff, { id }] = await Promise.all([requirePageAccess("billing-invoice"), params]);
  return <InvoicePage invoiceId={id} clinicSlug={staff.clinicSlug} clinicName={staff.clinicName} userId={staff.userId} preview={staff.preview} />;
}
