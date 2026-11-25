import type { Metadata } from "next";

import { BusinessesScreen } from "@/features/admin/businesses-screen";
import { requireAdminPageContext } from "@/server/admin-context";

export const metadata: Metadata = { title: "Businesses" };

export default async function Page() {
  // Layouts and pages render separately, so each page checks for itself.
  await requireAdminPageContext();
  return <BusinessesScreen />;
}
