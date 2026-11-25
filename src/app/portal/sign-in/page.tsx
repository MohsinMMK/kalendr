import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { PortalSignIn } from "@/features/portal/portal-sign-in";
import { getPatientAccount } from "@/server/patient-auth";
import { isPreviewMode } from "@/server/preview-repository";
import { turnstileSiteKey } from "@/server/turnstile";

export const metadata: Metadata = {
  title: "Sign in to your bookings",
  description: "See your bookings and documents.",
  robots: { index: false, follow: false },
};

export default async function PortalSignInPage() {
  const preview = isPreviewMode();
  if (!preview && await getPatientAccount(await headers())) redirect("/portal");
  return <PortalSignIn preview={preview} turnstileSiteKey={preview ? null : turnstileSiteKey()} />;
}
