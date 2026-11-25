"use client";

import Link from "next/link";
import { CalendarDays, CalendarX2, Clock3, Hourglass } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { declineReasonLabels } from "@/lib/approval";

import { useTerms } from "../terms/business-profile-context";
import { formatDateTime } from "./booking-format";
import type { ManageBookingSnapshot } from "./booking-types";

export const hiddenAddressNote = "We will send the address once your booking is confirmed.";

/** The way back to the business's booking page, shown once a request is closed. */
export function BookAnotherTimeLink({ clinicSlug }: { clinicSlug: string }) {
  return (
    <Button size="lg" className="w-full sm:w-fit" render={<Link href={`/book/${encodeURIComponent(clinicSlug)}`} />}>
      <CalendarDays aria-hidden="true" />
      Book another time
    </Button>
  );
}

/**
 * What a request that is not booked yet looks like on the manage page: waiting (with the other times the customer
 * offered), declined (with the reason) or expired. Booked and other states show nothing here.
 */
export function ApprovalStatusCard({ snapshot }: { snapshot: ManageBookingSnapshot }) {
  const t = useTerms();
  const { appointment, clinic, location, proposedStarts, declineReason } = snapshot;

  if (appointment.status === "requested") {
    return (
      <Alert role={undefined} variant="info">
        <Hourglass aria-hidden="true" />
        <AlertTitle>Waiting for approval</AlertTitle>
        <AlertDescription>
          <p>
            {clinic.name} has your request and has not answered yet. You will hear back by email or message. Until then this time is not
            confirmed.
          </p>
          {proposedStarts && proposedStarts.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="font-medium text-foreground">Also offered</p>
              <ul className="flex list-disc flex-col gap-0.5 ps-5 tabular-nums">
                {proposedStarts.map((start) => (
                  <li key={start}>{formatDateTime(start, clinic.locale, location.timezone)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }

  if (appointment.status === "declined") {
    const reason = declineReason ? declineReasonLabels[declineReason] : undefined;
    return (
      <div className="flex flex-col gap-3">
        <Alert role={undefined} variant="error">
          <CalendarX2 aria-hidden="true" />
          <AlertTitle>Your {t.appointment} request was not accepted</AlertTitle>
          <AlertDescription>
            {clinic.name} could not take this request.{reason ? ` ${reason}.` : ""}
          </AlertDescription>
        </Alert>
        <BookAnotherTimeLink clinicSlug={clinic.slug} />
      </div>
    );
  }

  if (appointment.status === "expired") {
    return (
      <div className="flex flex-col gap-3">
        <Alert role={undefined}>
          <Clock3 aria-hidden="true" />
          <AlertTitle>This request has closed</AlertTitle>
          <AlertDescription>Nobody answered before the start time, so this request has closed.</AlertDescription>
        </Alert>
        <BookAnotherTimeLink clinicSlug={clinic.slug} />
      </div>
    );
  }

  return null;
}
