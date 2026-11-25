import Link from "next/link";
import { CalendarX2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { BookingShell } from "@/features/booking/booking-shell";

export default function ManageNotFound() {
  return (
    <BookingShell>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarX2Icon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle className="font-semibold">
            <h1>This booking link is unavailable</h1>
          </EmptyTitle>
          <EmptyDescription>
            The link may have expired or the appointment may no longer exist. Contact the business you booked with, or see your bookings in your account.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="lg" render={<Link href="/portal" />}>
            Go to your account
          </Button>
        </EmptyContent>
      </Empty>
    </BookingShell>
  );
}
