import type { Metadata } from "next";

import { MessagesScreen } from "@/features/admin/messages-screen";
import { requireAdminPageContext } from "@/server/admin-context";

export const metadata: Metadata = { title: "Messages" };

export default async function Page() {
  // Layouts and pages render separately, so each page checks for itself.
  await requireAdminPageContext();
  return <MessagesScreen />;
}
