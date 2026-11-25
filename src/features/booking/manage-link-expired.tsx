import Link from "next/link";
import { LockKeyhole } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

/** Shown instead of a booking when its private link is too old. Nothing about the booking or the business appears here. */
export function ManageLinkExpired() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockKeyhole aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="font-semibold">
          <h1>Sign in to see this booking</h1>
        </EmptyTitle>
        <EmptyDescription>
          This link has expired to keep your details safe. Sign in with the email or phone number you booked with to see it.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="lg" render={<Link href="/portal/sign-in" />}>Sign in</Button>
      </EmptyContent>
    </Empty>
  );
}
