import type { Metadata } from "next";

import { NotificationsWorkspace } from "@/features/clinic/notifications-workspace";
import { requireStaffPageContext } from "@/server/staff-context";

export const metadata: Metadata = {
  title: "Notifications",
  description: "Choose what you hear about, and how.",
  robots: { index: false, follow: false },
};

export default async function NotificationsPage() {
  const staff = await requireStaffPageContext();
  return <NotificationsWorkspace preview={staff.preview} />;
}
