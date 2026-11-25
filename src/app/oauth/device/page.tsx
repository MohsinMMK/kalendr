import type { Metadata } from "next";

import { DeviceScreen } from "@/features/oauth/device-screen";
import { staffOrSignIn } from "@/server/approval-page";

export const metadata: Metadata = {
  title: "Connect a device",
  description: "Type the code from the Kalendr browser extension to connect it.",
  robots: { index: false, follow: false },
};

export default async function DevicePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await staffOrSignIn("/oauth/device", await searchParams);
  return <DeviceScreen businessName={staff.clinicName} personName={staff.userName} />;
}
