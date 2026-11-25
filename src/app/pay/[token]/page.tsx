import type { Metadata } from "next";

import { BookingShell } from "@/features/booking/booking-shell";
import { PayLink } from "@/features/booking/pay-link";

export const metadata: Metadata = {
  title: "Pay for your booking",
  description: "Pay the amount a business asked for to confirm your booking.",
  robots: { index: false, follow: false },
  // The link is the secret: it must never leak in a referrer header.
  referrer: "no-referrer",
};

interface PayLinkPageProps {
  params: Promise<{ token: string }>;
}

/** The page behind a payment link a business sent. The page itself reads nothing private; the client asks the server. */
export default async function PayLinkPage({ params }: PayLinkPageProps) {
  const { token } = await params;
  return (
    <BookingShell>
      <PayLink token={token} />
    </BookingShell>
  );
}
