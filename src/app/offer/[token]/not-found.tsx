import { CalendarX2Icon } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { BookingShell } from "@/features/booking/booking-shell";

export default function OfferNotFound() {
  return (
    <BookingShell>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><CalendarX2Icon aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="font-semibold"><h1>This link is not valid</h1></EmptyTitle>
          <EmptyDescription>The link may be mistyped or too old. Open it again from your message, or contact the business that sent it.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </BookingShell>
  );
}
