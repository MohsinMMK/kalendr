"use client";

import { CalendarPlus, ChevronDownIcon, DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Menu, MenuLinkItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { bookingCalendarEvent, googleCalendarHref, outlookComHref } from "@/lib/calendar-links";
import { cn } from "@/lib/utils";

import { useTerms } from "../terms/business-profile-context";

const noSubscribe = () => () => {};

/** The page's origin once in the browser, so the calendar note can carry a full manage link. */
function useOrigin(): string {
  return useSyncExternalStore(noSubscribe, () => window.location.origin, () => "");
}

/** "Add to calendar": Google and Outlook.com open a filled-in event; Apple and Outlook take the calendar file. */
export function AddToCalendarMenu({
  fileHref,
  managePath,
  serviceName,
  businessName,
  startsAt,
  endsAt,
  personName,
  location,
  className,
}: {
  /** The booking's calendar file (.ics). */
  fileHref: string;
  /** The customer's manage page, written into the event's note. Left out on the signed-in portal. */
  managePath?: string;
  serviceName: string;
  businessName: string;
  startsAt: string;
  endsAt: string;
  personName?: string;
  location?: { name: string; address?: string; city?: string };
  className?: string;
}) {
  const t = useTerms();
  const origin = useOrigin();
  const event = bookingCalendarEvent({
    serviceName,
    businessName,
    startsAt,
    endsAt,
    personName,
    location,
    manageUrl: origin && managePath ? `${origin}${managePath}` : undefined,
    manageLabel: `Manage ${t.appointment}`,
  });

  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="lg" className={cn("w-full sm:w-auto", className)} />}>
        <CalendarPlus aria-hidden="true" />
        Add to calendar
        <ChevronDownIcon aria-hidden="true" className="opacity-72" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-52">
        <MenuLinkItem render={<a href={googleCalendarHref(event)} target="_blank" rel="noopener noreferrer" />}>
          <ExternalLinkIcon aria-hidden="true" />
          Google Calendar
        </MenuLinkItem>
        <MenuLinkItem render={<a href={fileHref} download />}>
          <DownloadIcon aria-hidden="true" />
          Apple Calendar
        </MenuLinkItem>
        <MenuLinkItem render={<a href={fileHref} download />}>
          <DownloadIcon aria-hidden="true" />
          Outlook
        </MenuLinkItem>
        <MenuLinkItem render={<a href={outlookComHref(event)} target="_blank" rel="noopener noreferrer" />}>
          <ExternalLinkIcon aria-hidden="true" />
          Outlook.com
        </MenuLinkItem>
      </MenuPopup>
    </Menu>
  );
}
