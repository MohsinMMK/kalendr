import type { Metadata } from "next";

import { MessagesWorkspace } from "@/features/clinic/messages-workspace";
import { currentStaffWords } from "@/server/business-profile";
import { emailIsConfigured } from "@/server/env";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  const t = await currentStaffWords();
  return {
    title: labels.messages,
    description: `${t.Customer} updates and bookings that need a person.`,
  };
}

export default async function MessagesPage() {
  await requirePageAccess("messages");
  return <MessagesWorkspace emailConnected={emailIsConfigured()} />;
}
