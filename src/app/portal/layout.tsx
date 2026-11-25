import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppSupport } from "@/features/app-support/app-support";

// The portal installs as its own app: it opens "My visits", not the staff schedule.
export const metadata: Metadata = {
  manifest: "/portal/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "My visits" },
};

export default function PortalLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <>
      {children}
      <AppSupport scope="portal" appName="My visits" />
    </>
  );
}
