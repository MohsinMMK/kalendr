import Link from "next/link";
import { FileQuestionIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { BookingShell } from "@/features/booking/booking-shell";
import { resolveBusinessProfile } from "@/lib/terminology";

const neutralProfile = resolveBusinessProfile({ businessType: "other" });

/** Shown for an unknown business, an unknown form, a paused form and a draft alike, so a visitor learns nothing about which exist. */
export default function RoutingFormNotFound() {
  return (
    <BookingShell profile={neutralProfile}>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileQuestionIcon aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="font-semibold"><h1>This form is not available</h1></EmptyTitle>
          <EmptyDescription>Check the link you were given, or ask the business for a new one.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="lg" render={<Link href="/" />}>Return to Kalendr</Button>
        </EmptyContent>
      </Empty>
    </BookingShell>
  );
}
