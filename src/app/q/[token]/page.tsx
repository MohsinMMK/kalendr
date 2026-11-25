import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { QueueTicketView } from "@/features/queue/queue-ticket";
import { ApiError } from "@/server/api-error";
import { getQueueTicket } from "@/server/queue-screens";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your place in the queue",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** The customer's own queue page, from the QR or text the desk gave them. Works on the day only. */
export default async function QueueTicketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ticket = await getQueueTicket(token).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  if (!ticket) notFound();
  return <QueueTicketView token={token} initial={ticket} />;
}
