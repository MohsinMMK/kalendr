import type { Metadata } from "next";

import { ServiceEditor } from "@/features/clinic/service-editor";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return { title: labels.services, robots: { index: false, follow: false } };
}

export default async function ServiceEditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  await requirePageAccess("services");
  const { id } = await params;
  const { tab } = await searchParams;
  return <ServiceEditor serviceId={id} initialTab={typeof tab === "string" ? tab : undefined} />;
}
