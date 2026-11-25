import type { Metadata } from "next";

import { RecordsWorkspace } from "@/features/clinic/records-workspace";
import { isClinicalBusinessType } from "@/lib/business-types";
import { profileWords } from "@/lib/terminology";
import { currentStaffBusinessProfile } from "@/server/business-profile";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  const profile = await currentStaffBusinessProfile();
  const t = profileWords(profile);
  return {
    title: labels.records,
    description: isClinicalBusinessType(profile.businessType) ? "Visit notes, reports and prescriptions." : `${t.Visit} notes and reports.`,
    robots: { index: false, follow: false },
  };
}

const single = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

export default async function RecordsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePageAccess("records");
  const params = await searchParams;
  return <RecordsWorkspace initialPatientId={single(params.patient)} initialVisitId={single(params.visit)} openNew={single(params.new) === "1"} />;
}
