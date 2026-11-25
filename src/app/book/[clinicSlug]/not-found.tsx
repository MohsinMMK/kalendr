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
import { resolveBusinessProfile } from "@/lib/terminology";

/** No business matched the link, so neither its words nor clinical notices apply here. */
const neutralProfile = resolveBusinessProfile({ businessType: "other" });

export default function BookingNotFound() {
  return (
    <BookingShell profile={neutralProfile}>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarX2Icon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle className="font-semibold">
            <h1>This booking page is unavailable</h1>
          </EmptyTitle>
          <EmptyDescription>
            Check the link you were given or return to Kalendr.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="lg" render={<Link href="/" />}>
            Return to Kalendr
          </Button>
        </EmptyContent>
      </Empty>
    </BookingShell>
  );
}
