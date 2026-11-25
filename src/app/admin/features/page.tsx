import type { Metadata } from "next";

import { FeaturesScreen } from "@/features/admin/features-screen";
import { requireAdminPageContext } from "@/server/admin-context";

export const metadata: Metadata = { title: "Features" };

export default async function Page() {
  // Layouts and pages render separately, so each page checks for itself.
  await requireAdminPageContext();
  return <FeaturesScreen />;
}
