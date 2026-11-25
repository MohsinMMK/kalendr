import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { PortalWorkspace } from "@/features/portal/portal-workspace";
import { getPatientAccount } from "@/server/patient-auth";
import { getPortalSnapshot } from "@/server/patient-portal";
import { isPreviewMode } from "@/server/preview-repository";

export const metadata: Metadata = {
  title: "Your bookings",
  description: "Your bookings and documents.",
  robots: { index: false, follow: false },
};

export default async function PortalPage() {
  if (isPreviewMode()) return <PortalWorkspace />;
  const account = await getPatientAccount(await headers());
  if (!account) redirect("/portal/sign-in");
  return <PortalWorkspace initialSnapshot={await getPortalSnapshot(account)} now={new Date().toISOString()} />;
}
