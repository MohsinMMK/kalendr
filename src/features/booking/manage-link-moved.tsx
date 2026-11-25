"use client";

import Link from "next/link";
import { CalendarClockIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

import { useTerms } from "../terms/business-profile-context";

/**
 * Shown for a reschedule link that a move replaced. The link can no longer manage the booking; this only says it moved,
 * gives the new time when the same customer still holds it, and offers to book again. It never carries the new link.
 */
export function ManageLinkMoved({ businessName, serviceName, newTime, bookAgainPath }: {
  businessName: string;
  serviceName: string;
  newTime: { startsAt: string; timezone: string } | null;
  bookAgainPath: string | null;
}) {
  const t = useTerms();
  const when = newTime
    ? new Intl.DateTimeFormat("en-GB", { timeZone: newTime.timezone, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date(newTime.startsAt))
    : null;
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CalendarClockIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="font-semibold">
          <h1>This {t.appointment} was moved</h1>
        </EmptyTitle>
        <EmptyDescription>
          {when
            ? <>Your {serviceName} with {businessName} is now on <strong data-testid="moved-new-time">{when}</strong>. For your privacy this old link can no longer change it: use the link in your latest message to manage it.</>
            : <>This link was for a {t.appointment} with {businessName} that has since moved, and it can no longer be used to manage it.{bookAgainPath ? ` You can book ${serviceName} again.` : ""}</>}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {bookAgainPath ? <Button size="lg" render={<Link href={bookAgainPath} />}>Book again</Button> : null}
        <Button size="lg" variant="outline" render={<Link href="/portal" />}>Go to your account</Button>
      </EmptyContent>
    </Empty>
  );
}
