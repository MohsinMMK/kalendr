import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import Link from "next/link";
import { CalendarClockIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { resolveBusinessProfile } from "@/lib/terminology";
import { pausedNoticeText, slugIsPaused } from "@/server/tenant-pause";

import { BookingShell } from "./booking-shell";

const neutralProfile = resolveBusinessProfile({ businessType: "other" });

/**
 * What a public page shows when its catalog is missing: the neutral paused notice if the business is paused, else the
 * ordinary 404. The notice carries no business name or reason.
 */
export async function unavailablePage(slug: string): Promise<ReactNode> {
  if (!(await slugIsPaused(slug))) notFound();
  return (
    <BookingShell profile={neutralProfile}>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><CalendarClockIcon aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="font-semibold"><h1>{pausedNoticeText}</h1></EmptyTitle>
          <EmptyDescription>Please check again later, or contact the business directly.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="lg" render={<Link href="/" />}>Return to Kalendr</Button>
        </EmptyContent>
      </Empty>
    </BookingShell>
  );
}
