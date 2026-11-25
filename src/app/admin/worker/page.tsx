import type { Metadata } from "next";

import { WorkerScreen } from "@/features/admin/worker-screen";
import { requireAdminPageContext } from "@/server/admin-context";

export const metadata: Metadata = { title: "Worker" };

export default async function Page() {
  // Layouts and pages render separately, so each page checks for itself.
  await requireAdminPageContext();
  return <WorkerScreen />;
}
