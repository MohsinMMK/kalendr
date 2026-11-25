import type { Metadata } from "next";

import { AbuseScreen } from "@/features/admin/abuse-screen";
import { requireAdminPageContext } from "@/server/admin-context";

export const metadata: Metadata = { title: "Abuse" };

export default async function Page() {
  // Layouts and pages render separately, so each page checks for itself.
  await requireAdminPageContext();
  return <AbuseScreen />;
}
