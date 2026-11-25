import type { Metadata } from "next";

import { BusinessDetail } from "@/features/admin/business-detail";
import { requireAdminPageContext } from "@/server/admin-context";

export const metadata: Metadata = { title: "Business" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPageContext();
  const { id } = await params;
  return <BusinessDetail tenantId={id} />;
}
