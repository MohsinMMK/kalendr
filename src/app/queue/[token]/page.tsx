import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { QueueScreenView } from "@/features/queue/queue-screen";
import { ApiError } from "@/server/api-error";
import { getQueueScreen } from "@/server/queue-screens";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Waiting room",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** The waiting-room TV. Opened from a secret link the desk made; shows token numbers only. */
export default async function QueueScreenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const screen = await getQueueScreen(token).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  if (!screen) notFound();
  return <QueueScreenView token={token} initial={screen} />;
}
