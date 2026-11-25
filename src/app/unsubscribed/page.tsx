import type { Metadata } from "next";
import { BellOffIcon, CircleAlertIcon } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { BookingShell } from "@/features/booking/booking-shell";
import { resolveBusinessProfile } from "@/lib/terminology";

export const metadata: Metadata = {
  title: "Unsubscribed",
  description: "Marketing messages have been turned off.",
  robots: { index: false, follow: false },
};

// The address names no business, so the page uses plain words and no clinic-only footer.
const neutralProfile = resolveBusinessProfile({ businessType: "other" });

interface UnsubscribedProps {
  searchParams: Promise<{ status?: string | string[] }>;
}

/**
 * Where the unsubscribe link in a marketing message ends up. The unsubscribing has already happened by the time this
 * page opens; it only says so. It shows no business or customer details, so nothing can be read from the address.
 */
export default async function UnsubscribedPage({ searchParams }: UnsubscribedProps) {
  const { status } = await searchParams;
  const invalid = status === "invalid";
  return (
    <BookingShell profile={neutralProfile}>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{invalid ? <CircleAlertIcon aria-hidden="true" /> : <BellOffIcon aria-hidden="true" />}</EmptyMedia>
          <EmptyTitle className="font-semibold"><h1>{invalid ? "This link is not valid" : "You are unsubscribed"}</h1></EmptyTitle>
          <EmptyDescription>
            {invalid
              ? "The link may be mistyped or too old. Open it again from your message, or reply to the email to ask the business to stop."
              : "You will not get marketing messages from this business any more. You will still get messages about your bookings, like reminders and changes."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </BookingShell>
  );
}
