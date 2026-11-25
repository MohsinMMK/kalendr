"use client";

import { CalendarDays, Clock3, Palmtree, TriangleAlert, WifiOff } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { Practitioner, TimeSlot } from "@/lib/domain";

import { SlotPicker } from "../slot-picker";
import type { BookingDisplay } from "../use-booking-display";
import { StepHeader } from "./step-header";

/** Someone whose times are closed for a while, with the note they left and whether a teammate covers. */
export interface AwayNotice {
  practitionerId: string;
  startsAt: string;
  endsAt: string;
  note: string | null;
  coverPractitionerId: string | null;
}

/** "When works for you?" The calendar with the earliest open date already showing. */
export function TimeStep({
  slots,
  awayNotices = [],
  fullDays = [],
  isLoading,
  loadError,
  onRetry,
  isPreview,
  practitioners,
  selectedSlotId,
  showPractitioner,
  error,
  emptyMessage,
  locale,
  timeZone,
  onSelect,
  onTimePicked,
  initialDate,
  display,
  onViewRange,
  isFetchingRange = false,
  rangeError,
  onRetryRange,
  holdNotice,
  waitlist,
  settingsInPanel = false,
}: {
  slots: TimeSlot[];
  awayNotices?: AwayNotice[];
  /** Days a booking limit filled, as `YYYY-MM-DD` in the business timezone. */
  fullDays?: string[];
  isLoading: boolean;
  loadError: string;
  onRetry: () => void;
  isPreview: boolean;
  practitioners: Practitioner[];
  selectedSlotId?: string;
  showPractitioner: boolean;
  error?: string;
  emptyMessage: string;
  locale: string;
  timeZone: string;
  onSelect: (slot: TimeSlot) => void;
  onTimePicked: () => void;
  initialDate?: string;
  display?: BookingDisplay;
  onViewRange?: (range: { from: number; to: number }) => void;
  isFetchingRange?: boolean;
  rangeError?: string;
  onRetryRange?: () => void;
  /** Why the time was cleared: someone else took it, or the hold ran out. */
  holdNotice?: { kind: "taken" | "expired"; message: string };
  /** Shown under the times and under the empty state: "No time suits? Join the waitlist" (feature 21). */
  waitlist?: ReactNode;
  /** The booking side panel shows the time zone and clock from 1024px. */
  settingsInPanel?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <StepHeader
        title="When works for you?"
        hideTitle
        aside={
          isPreview ? (
            <Badge variant="info">
              <WifiOff aria-hidden="true" />
              Preview availability
            </Badge>
          ) : null
        }
      />
      {holdNotice ? (
        <Alert variant="warning" role="status">
          <Clock3 aria-hidden="true" />
          <AlertTitle>{holdNotice.kind === "taken" ? "That time is no longer open" : "Your held time ended"}</AlertTitle>
          <AlertDescription>{holdNotice.message}</AlertDescription>
        </Alert>
      ) : null}
      {awayNotices.map((notice) => {
        const person = practitioners.find((entry) => entry.id === notice.practitionerId);
        const cover = practitioners.find((entry) => entry.id === notice.coverPractitionerId);
        return (
          <Alert key={`${notice.practitionerId}:${notice.startsAt}`} variant="info">
            <Palmtree aria-hidden="true" />
            <AlertTitle>{person ? `${person.name} is away` : "Someone is away"}</AlertTitle>
            <AlertDescription>
              {notice.note ? <span>{notice.note}</span> : null}
              {cover ? <span>{`${cover.name} is covering, so you are seeing their times for those days.`}</span> : null}
            </AlertDescription>
          </Alert>
        );
      })}
      {isLoading ? (
        <div aria-live="polite" aria-busy="true" className="flex gap-5 max-md:flex-col">
          <span className="sr-only">Loading available times</span>
          <Skeleton className="h-80 w-full rounded-xl md:w-96" aria-hidden="true" />
          <div className="flex flex-1 flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-4 w-24 rounded" />
            <div className="grid grid-cols-3 content-start gap-2">
              {[0, 1, 2, 3, 4, 5].map((item) => (
                <Skeleton key={item} className="h-11 rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {!isLoading && slots.length > 0 ? (
        <SlotPicker
          id="booking-slots"
          name="booking-slot"
          slots={slots}
          practitioners={practitioners}
          selectedSlotId={selectedSlotId}
          onSelect={onSelect}
          onTimePicked={onTimePicked}
          locale={locale}
          timeZone={timeZone}
          showPractitioner={showPractitioner}
          error={error}
          initialDate={initialDate}
          fullDays={fullDays}
          display={display}
          onViewRange={onViewRange}
          isFetching={isFetchingRange}
          rangeError={rangeError}
          onRetryRange={onRetryRange}
          settingsInPanel={settingsInPanel}
        />
      ) : null}
      {!isLoading && loadError ? (
        <Alert variant="error">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Times are unavailable</AlertTitle>
          <AlertDescription>
            <span>{loadError}</span>
            <Button variant="outline" className="w-fit" onClick={onRetry}>Try loading times again</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {!isLoading && !loadError && slots.length === 0 ? (
        <Empty id={error ? "booking-slots" : undefined} tabIndex={error ? -1 : undefined} className="rounded-xl bg-muted/48 px-4 py-8 outline-none md:py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarDays aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle className="font-semibold text-base">{fullDays.length > 0 ? "Fully booked" : "No matching times are open"}</EmptyTitle>
            <EmptyDescription>{fullDays.length > 0 ? "Every open day in this range is full. Please try a later date." : emptyMessage}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {!isLoading && !loadError ? waitlist : null}
    </div>
  );
}
