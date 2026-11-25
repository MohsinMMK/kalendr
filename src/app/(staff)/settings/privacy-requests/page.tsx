import type { Metadata } from "next";

import { PrivacyRequestsWorkspace } from "@/features/clinic/privacy-requests-workspace";
import { currentStaffWords } from "@/server/business-profile";
import { requirePageAccess } from "@/server/staff-page-guard";

export async function generateMetadata(): Promise<Metadata> {
  const t = await currentStaffWords();
  return {
    title: "Privacy requests",
    description: `${t.Customer} requests to download, correct or delete their information.`,
  };
}

export default async function PrivacyRequestsPage() {
  await requirePageAccess("settings-privacy-requests");
  return <PrivacyRequestsWorkspace />;
}
