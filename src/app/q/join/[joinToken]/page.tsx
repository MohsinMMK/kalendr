import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { QueueJoin } from "@/features/queue/queue-join";
import { ApiError } from "@/server/api-error";
import { getJoinView } from "@/server/queue-door";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Join the queue",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** Behind the QR code at the door: join the queue from your own phone. */
export default async function QueueJoinPage({ params }: { params: Promise<{ joinToken: string }> }) {
  const { joinToken } = await params;
  const view = await getJoinView(joinToken).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  if (!view) notFound();
  return (
    <QueueJoin token={joinToken} initial={view} />
  );
}
