import type { Metadata } from "next";

import { ConsentScreen } from "@/features/oauth/consent-screen";
import { staffOrSignIn } from "@/server/approval-page";

export const metadata: Metadata = {
  title: "Connect an app",
  description: "Approve what an app may do in your Kalendr account.",
  robots: { index: false, follow: false },
};

/** Where an app sends a signed-in person to approve it. The search string is the app's OAuth request, read by the screen. */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await staffOrSignIn("/oauth/authorize", await searchParams);
  return <ConsentScreen businessName={staff.clinicName} personName={staff.userName} />;
}
