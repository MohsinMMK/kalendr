"use client";

import Image from "next/image";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Clock3,
  MapPin,
  PhoneIcon,
  UserRound,
  Video,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardPanel } from "@/components/ui/card";
import { calendarFileHref } from "@/lib/calendar-links";
import { cn } from "@/lib/utils";
import type { Clinic, ContactChannel, Location, Service } from "@/lib/domain";

import { useTerms } from "../terms/business-profile-context";
import { AddToCalendarMenu } from "./add-to-calendar-menu";
import { JoinVideoLink } from "../video/join-video-link";
import { CheckInCard } from "./check-in-card";
import { HeardFromCard } from "./heard-from-card";
import { formatDateTime, getDurationLabel, phoneHref } from "./booking-format";
import { meetLabel } from "./booking-options";
import type { BookingSuccess } from "./booking-types";
import type { LocationOptionKind } from "@/lib/service-setup";

const contactChannelPhrases: Record<ContactChannel, string> = {
  sms: "text message",
  whatsapp: "WhatsApp",
  email: "email",
  phone: "phone",
};

/** One labelled line of a booking's details, shared by the confirmation and manage screens. */
export function BookingDetailRow({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    // A <dl> group may hold only <dt> and <dd>, so the icon sits inside the term.
    <div className="relative min-w-0 ps-7">
      <dt className="text-muted-foreground text-xs">
        <Icon className="absolute start-0 top-0.5 size-4" aria-hidden="true" />
        {label}
      </dt>
      <dd className="wrap-break-word font-medium text-sm">{children}</dd>
    </div>
  );
}

/** What happens next for each way of meeting. "You call us" shows the number only now, after booking. */
function meetingNote(meeting: { kind: LocationOptionKind; detail: string }, businessPhone: string): string {
  switch (meeting.kind) {
    case "they_call":
      return `Call ${businessPhone} at your time.`;
    case "we_call":
      return "We call the number you gave at your time.";
    case "video":
      return "We send the video link before your time.";
    case "their_address":
      return `We come to ${meeting.detail}.`;
    case "in_person":
      return "";
  }
}

/**
 * The screen after booking: booked, request sent, or a preview that was not saved.
 * The mark pops once, then the details, the calendar file and the manage link.
 */
export function BookingConfirmation({
  success,
  clinic,
  location,
  service,
  personName,
  preferredChannel,
  durationMinutes,
  meeting,
  embedded = false,
}: {
  success: BookingSuccess;
  clinic: Clinic;
  location: Location;
  service: Service;
  personName?: string;
  preferredChannel: ContactChannel;
  /** The length that was booked, when the service offers several. Falls back to the service's usual length. */
  durationMinutes?: number;
  /** How the customer chose to meet. Left out for in-person bookings and older services. */
  meeting?: { kind: LocationOptionKind; detail: string };
  /** Shown inside another website, where the extra questions are left out. */
  embedded?: boolean;
}) {
  const t = useTerms();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isRequest = success.status === "requested";
  const hideLocation = isRequest && Boolean(service.approval?.hideLocationUntilConfirmed);
  const manageHref = `/manage/${encodeURIComponent(success.manageToken)}`;

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const nextSteps = success.previewMode
    ? []
    : isRequest
      ? [
          {
            title: `The ${t.business} reviews your time`,
            detail: `${clinic.name} checks this time against its schedule.`,
          },
          {
            title: "You hear back",
            detail: `${clinic.name} replies by email or message, most likely by ${contactChannelPhrases[preferredChannel]}. Hold off on travel plans until then.`,
          },
          {
            title: "Keep your manage link",
            detail: `Open Manage ${t.appointment} and bookmark the page to follow this request or change it.`,
          },
        ]
      : [
          {
            title: "Keep your manage link",
            detail: `Open Manage ${t.appointment} and bookmark the page. It is where you confirm attendance, move the time, or cancel.`,
          },
          {
            title: "Add it to your calendar",
            detail: `Use Add to calendar so this ${t.appointment} shows in your own calendar.`,
          },
          {
            title: "Need a hand?",
            detail: `Call ${clinic.name} on ${clinic.phone}.`,
          },
        ];

  return (
    <section aria-labelledby="booking-confirmation-title" className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          aria-hidden="true"
          className={cn(
            "flex size-12 items-center justify-center rounded-full motion-safe:animate-toast-success-odd",
            isRequest || success.previewMode ? "bg-info/8 text-info-foreground" : "bg-success/8 text-success-foreground",
          )}
        >
          {isRequest ? <Clock3 className="size-6" /> : <CheckCircle2 className="size-6" />}
        </div>
        <div className="flex flex-col gap-1">
          <h1
            id="booking-confirmation-title"
            ref={headingRef}
            tabIndex={-1}
            className="font-heading font-semibold text-2xl outline-none"
          >
            {success.previewMode ? `${t.Appointment} preview` : isRequest ? "Your request is waiting for approval" : "You’re booked"}
          </h1>
          <p className="max-w-prose text-muted-foreground text-sm">
            {success.previewMode
              ? `This demonstration has not been saved. Contact the ${t.business} to arrange ${t.anAppointment}.`
              : isRequest
                ? `${clinic.name} will review this time and reply by email or message. Your ${t.appointment} is not confirmed until then.`
                : `Your booking is saved. Use Manage ${t.appointment} to view the details or make a change.`}
          </p>
          {service.afterBooking?.successMessage && !success.previewMode ? (
            <p className="max-w-prose whitespace-pre-line text-sm" data-testid="success-message">{service.afterBooking.successMessage}</p>
          ) : null}
        </div>
      </div>

      {success.previewMode ? (
        <Alert role={undefined} variant="info">
          <WifiOff aria-hidden="true" />
          <AlertDescription>Preview mode: this demonstration was not saved.</AlertDescription>
        </Alert>
      ) : null}

      <Card className="overflow-hidden">
        {service.imageUrl ? (
          <div className="relative aspect-[5/2] w-full overflow-hidden border-b bg-muted">
            <Image src={service.imageUrl} alt="" fill unoptimized sizes="(min-width: 640px) 576px, 100vw" className="object-cover" />
          </div>
        ) : null}
        {service.afterBooking?.hideDetails && !success.previewMode ? null : (
        <CardPanel className="p-5">
          <dl className="flex flex-col gap-3.5">
            <BookingDetailRow icon={CalendarDays} label="Date and time">
              <span className="tabular-nums">{formatDateTime(success.startsAt, clinic.locale, location.timezone)}</span>
            </BookingDetailRow>
            <BookingDetailRow icon={ClipboardList} label={t.Service}>
              {service.name}
              <span className="block font-normal text-muted-foreground text-xs tabular-nums">
                {getDurationLabel(durationMinutes ?? service.durationMinutes)}
              </span>
            </BookingDetailRow>
            <BookingDetailRow icon={UserRound} label={t.Practitioner}>
              {personName ?? `${t.Business} team`}
            </BookingDetailRow>
            {meeting && meeting.kind !== "in_person" && !hideLocation ? (
              <BookingDetailRow icon={Video} label="How">
                {meetLabel(meeting.kind)}
                <span className="block font-normal text-muted-foreground text-xs">{meetingNote(meeting, clinic.phone)}</span>
              </BookingDetailRow>
            ) : null}
            <BookingDetailRow icon={MapPin} label={t.Location}>
              {hideLocation ? (
                <span className="block font-normal text-muted-foreground text-xs">We will send the address once your booking is confirmed.</span>
              ) : (
                <>
                  {location.name}
                  {location.address || location.city ? (
                    <span className="block font-normal text-muted-foreground text-xs">
                      {[location.address, location.city].filter(Boolean).join(", ")}
                    </span>
                  ) : null}
                </>
              )}
            </BookingDetailRow>
          </dl>
        </CardPanel>
        )}
        <CardFooter className="flex-col gap-2 border-t p-4 sm:flex-row sm:justify-end sm:px-5">
          {!success.previewMode ? (
            <AddToCalendarMenu
              className="sm:me-auto"
              fileHref={calendarFileHref(success.manageToken)}
              managePath={manageHref}
              serviceName={service.name}
              businessName={clinic.name}
              startsAt={success.startsAt}
              endsAt={success.endsAt}
              personName={personName}
              location={hideLocation ? undefined : location}
            />
          ) : null}
          <Button size="lg" className="w-full sm:w-auto" // A full page load, not a client-side move: the business's tracking scripts (if the visitor allowed them) would otherwise follow
            // the customer to their private manage page and read its address.
            render={<a href={manageHref} {...(embedded ? { target: "_blank", rel: "noopener" } : {})} />}>
            Manage {t.appointment}
            <ArrowRight aria-hidden="true" />
          </Button>
        </CardFooter>
      </Card>

      {!success.previewMode && !isRequest ? <JoinVideoLink manageToken={success.manageToken} className="w-full sm:w-auto sm:self-start" /> : null}

      {!success.previewMode && !isRequest ? (
        <CheckInCard manageToken={success.manageToken} appointmentId={success.appointmentId} />
      ) : null}

      {!success.previewMode && !embedded ? <HeardFromCard manageToken={success.manageToken} /> : null}

      {nextSteps.length > 0 ? (
        <section aria-labelledby="next-steps-title" className="flex flex-col gap-3">
          <h2 id="next-steps-title" className="font-heading font-semibold text-base">
            What happens next
          </h2>
          <ol className="flex list-decimal flex-col gap-2.5 ps-5 marker:text-muted-foreground marker:text-sm">
            {nextSteps.map((item) => (
              <li key={item.title} className="ps-1">
                <p className="font-medium text-sm">{item.title}</p>
                <p className="text-muted-foreground text-sm">{item.detail}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <Button
        variant="ghost"
        className="h-auto min-h-11 self-center whitespace-normal"
        render={<a href={phoneHref(clinic.phone)} />}
      >
        <PhoneIcon aria-hidden="true" />
        Call {clinic.name}
      </Button>
    </section>
  );
}
