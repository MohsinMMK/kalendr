import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { PortalPrivacyUnavailable, PortalPrivacyWorkspace } from "@/features/portal/privacy-workspace";
import { getPatientAccount } from "@/server/patient-auth";
import { isPreviewMode } from "@/server/preview-repository";

export const metadata: Metadata = {
  title: "Your privacy",
  description: "Choose what you receive, and ask for a copy of your details or for them to be removed.",
  robots: { index: false, follow: false },
};

export default async function PortalPrivacyPage() {
  if (isPreviewMode()) return <PortalPrivacyUnavailable />;
  if (!(await getPatientAccount(await headers()))) redirect("/portal/sign-in");
  return <PortalPrivacyWorkspace />;
}
