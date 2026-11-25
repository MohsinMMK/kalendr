"use client";

import Image from "next/image";
import { ChevronDown, ChevronUp, Globe, UserRound, type LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";

import { PhoneField, TextField } from "@/components/form-fields";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Drawer,
  DrawerHeader,
  DrawerPanel,
  DrawerPopup,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { zoneCity } from "@/lib/booking-page";
import { cn } from "@/lib/utils";

import { useHydrated, valueEntrance } from "./booking-motion";
import { BusinessLine, BusinessLogo, type SummaryLine } from "./booking-summary";
import { TimeZoneField } from "./picker-header";
import { FullNameField } from "./steps/details-step";
import type { BookingDisplay } from "./use-booking-display";

/** One choice in the panel. With `choices` it changes right there; otherwise its Change button opens that screen. */
export interface PanelLine extends SummaryLine {
  choices?: { value: string; label: string }[];
  choice?: string;
  onChoose?: (value: string) => void;
}

/** A choice still to make, shown greyed so the customer sees what is left. */
export interface PanelUpcoming {
  id: string;
  icon: LucideIcon;
  label: string;
}

export interface PanelDetails {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  phoneOnly: boolean;
  emailLocked: boolean;
  /** False on the details screen itself: the fields are there, so the panel only shows what was typed. */
  editable: boolean;
  onNamesChange: (names: { firstName: string; lastName: string }) => void;
  onPhoneChange: (phone: string) => void;
  onEmailChange: (email: string) => void;
}

export interface BookingPanelProps {
  business: { name: string; phone?: string | undefined; logoUrl?: string | null };
  title: string;
  lines: PanelLine[];
  upcoming: PanelUpcoming[];
  imageUrl?: string;
  /** Called with the line's id when its Change button is used. */
  onChange: (id: string) => void;
  /** The time zone, once the times are in view. */
  display?: BookingDisplay;
  details: PanelDetails;
}

function PanelRow({ idPrefix, line, onChange, onChangeChosen }: {
  idPrefix: string;
  line: PanelLine;
  onChange: (id: string) => void;
  onChangeChosen?: () => void;
}) {
  const labelId = `${idPrefix}-${line.id}-label`;
  const hydrated = useHydrated();
  // A new choice eases into its row; the first paint shows as it is.
  const valueKey = typeof line.value === "string" ? line.value : line.id;
  const valueMotion = hydrated ? valueEntrance : { initial: false as const };
  const editable = line.changeable && line.choices && line.choices.length > 1 && line.onChoose;
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-2">
      <p id={labelId} className="flex min-h-9 items-center gap-2 text-muted-foreground text-sm">
        <line.icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{line.label}</span>
      </p>
      <div className="min-w-0">
        {editable ? (
          <Select
            items={line.choices}
            value={line.choice ?? null}
            onValueChange={(next: string | null) => {
              if (next) line.onChoose?.(next);
            }}
          >
            <SelectTrigger aria-labelledby={labelId} className="w-full border-transparent bg-transparent shadow-none hover:bg-accent">
              {line.person ? <PersonAvatar name={line.person.name} image={line.person.photoUrl} className="size-6 text-[0.625rem]" /> : null}
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {line.choices?.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : line.changeable ? (
          <Button
            variant="ghost"
            className={cn("h-auto min-h-9 w-full justify-start whitespace-normal px-2.5 py-1.5 text-start font-medium", line.numeric && "tabular-nums")}
            onClick={() => {
              onChangeChosen?.();
              onChange(line.id);
            }}
          >
            <span className="sr-only">{`Change ${line.label.toLowerCase()}: `}</span>
            {line.person ? <PersonAvatar name={line.person.name} image={line.person.photoUrl} className="size-6 text-[0.625rem]" /> : null}
            <motion.span key={valueKey} {...valueMotion} className="min-w-0 wrap-break-word">{line.value}</motion.span>
          </Button>
        ) : (
          <p className={cn("flex min-h-9 items-center gap-2 px-2.5 font-medium text-sm wrap-break-word", line.numeric && "tabular-nums")}>
            {line.person ? <PersonAvatar name={line.person.name} image={line.person.photoUrl} className="size-6 text-[0.625rem]" /> : null}
            <motion.span key={valueKey} {...valueMotion}>{line.value}</motion.span>
          </p>
        )}
        {line.meta ? <p className="px-2.5 pb-1 text-muted-foreground text-xs tabular-nums">{line.meta}</p> : null}
      </div>
    </div>
  );
}

function DetailsSection({ idPrefix, details }: { idPrefix: string; details: PanelDetails }) {
  const [open, setOpen] = useState(false);
  const name = [details.firstName, details.lastName].filter(Boolean).join(" ");
  const typed = [name, details.phone, details.phoneOnly ? "" : details.email].filter(Boolean);

  if (!details.editable) {
    return typed.length > 0 ? (
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <UserRound className="size-4" aria-hidden="true" />
          Your details
        </p>
        {typed.map((value) => (
          <p key={value} className="ps-6 font-medium text-sm wrap-break-word">{value}</p>
        ))}
      </div>
    ) : null;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={<Button variant="ghost" className="h-auto min-h-11 w-full justify-between gap-3 whitespace-normal px-2.5 py-2 text-start" />}
      >
        <span className="flex min-w-0 items-center gap-2">
          <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block font-medium text-sm">Your details</span>
            <span className="block truncate font-normal text-muted-foreground text-xs">
              {typed.length > 0 ? typed.join(" · ") : "Fill in now, or at the last step"}
            </span>
          </span>
        </span>
        <ChevronDown aria-hidden="true" className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-4 px-0.5 pt-3 pb-1">
          <FullNameField
            id={`${idPrefix}-name`}
            fieldClassName=""
            label="Full name"
            autoComplete="name"
            firstName={details.firstName}
            lastName={details.lastName}
            onChange={details.onNamesChange}
          />
          <PhoneField
            id={`${idPrefix}-phone`}
            label="Mobile number"
            autoComplete="tel"
            value={details.phone}
            onChange={details.onPhoneChange}
          />
          {details.phoneOnly ? null : (
            <TextField
              id={`${idPrefix}-email`}
              label="Email address"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={details.email}
              readOnly={details.emailLocked}
              hint={details.emailLocked ? "Filled from your link" : undefined}
              onChange={(event) => details.onEmailChange(event.target.value)}
            />
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** What the panel holds, on the side from 1024px and in the drawer below it. */
function PanelBody({ idPrefix, onChangeChosen, business, lines, upcoming, imageUrl, onChange, display, details, showBusiness }: BookingPanelProps & {
  idPrefix: string;
  onChangeChosen?: () => void;
  showBusiness: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      {imageUrl ? (
        <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-muted">
          <Image src={imageUrl} alt="" fill unoptimized sizes="(min-width: 1024px) 320px, 100vw" className="object-cover" />
        </div>
      ) : null}
      {showBusiness ? <BusinessLine name={business.name} phone={business.phone} /> : null}
      <div className="flex flex-col gap-1">
        {lines.map((line) => (
          <PanelRow key={line.id} idPrefix={idPrefix} line={line} onChange={onChange} onChangeChosen={onChangeChosen} />
        ))}
        {upcoming.map((item) => (
          <div key={item.id} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-2 text-muted-foreground text-sm">
            <p className="flex min-h-9 items-center gap-2">
              <item.icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.label}</span>
            </p>
            <p className="px-2.5 text-muted-foreground italic">Not chosen yet</p>
          </div>
        ))}
        {display ? (
          // The time zone is one more row of the booking details, not a block of its own.
          <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-2">
            <p className="flex min-h-9 items-center gap-2 text-muted-foreground text-sm">
              <Globe aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">Time zone</span>
            </p>
            {display.zoneLocked ? (
              <p className="flex min-h-9 items-center px-2.5 text-sm">{zoneCity(display.businessZone)} time</p>
            ) : (
              <TimeZoneField id={`${idPrefix}-zone`} display={display} compact />
            )}
          </div>
        ) : null}
      </div>
      <Separator />
      <DetailsSection idPrefix={idPrefix} details={details} />
    </div>
  );
}

/** "Your appointment" with the business under it, and its logo beside both, so the customer knows who they book with. */
function PanelHeading({ title, business, as: Title = "h2" }: Pick<BookingPanelProps, "title" | "business"> & { as?: "h2" | typeof DrawerTitle }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <BusinessLogo name={business.name} logoUrl={business.logoUrl} className="size-11" />
      <div className="min-w-0">
        <Title className="font-heading font-semibold text-base">{title}</Title>
        <BusinessLine name={business.name} phone={business.phone} />
      </div>
    </div>
  );
}

/**
 * The booking as it builds, beside the steps from 1024px. Choices change right here: the service, the person, the
 * place and the length are menus; the time and how to meet open their screen. Below 1024px it is hidden, and
 * `BookingPanelBar` opens the same panel in a drawer.
 */
export function BookingPanel(props: BookingPanelProps) {
  return (
    <aside aria-label={props.title} className="max-lg:hidden lg:self-stretch lg:border-s lg:ps-8">
      <div className="lg:sticky lg:top-6">
      <ScrollAreaPrimitive.Root>
        <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring lg:max-h-[calc(100dvh-3rem)]">
          <ScrollAreaPrimitive.Content className="lg:pe-1 lg:pb-2" style={{ minWidth: 0 }}>
            <PanelHeading {...props} />
            <PanelBody {...props} idPrefix="panel" showBusiness={false} />
          </ScrollAreaPrimitive.Content>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar orientation="vertical" />
      </ScrollAreaPrimitive.Root>
      </div>
    </aside>
  );
}

/** Below 1024px: a floating bar at the bottom with the booking so far; tapping it opens the panel in a drawer. */
export function BookingPanelBar({ action, ...props }: BookingPanelProps & {
  /** The screen's main button (Continue, Confirm) on a phone: it sits right under the bar, full width, as one block. */
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const glance = props.lines.map((line) => line.value).join(" · ");
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 z-30 flex justify-center lg:hidden",
        action ? "bottom-0" : "bottom-[max(--spacing(4),env(safe-area-inset-bottom))] px-4",
      )}
    >
      <div
        className={cn(
          "pointer-events-auto flex w-full flex-col",
          action
            ? "gap-2 rounded-t-2xl border border-b-0 bg-background/95 px-3 pt-2 pb-[max(--spacing(3),env(safe-area-inset-bottom))] shadow-lg backdrop-blur [&>button:last-child]:w-full"
            : "max-w-lg",
        )}
      >
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger
          render={
            <Button
              variant={action ? "ghost" : "outline"}
              className={cn(
                "h-auto min-h-12 w-full justify-between gap-3 whitespace-normal px-4 py-2 text-start",
                action ? "rounded-xl px-2" : "rounded-2xl bg-background/95 shadow-lg backdrop-blur",
              )}
            />
          }
        >
          <span className="flex min-w-0 items-center gap-3">
            <BusinessLogo name={props.business.name} logoUrl={props.business.logoUrl} className="size-8" />
            <span className="min-w-0">
            <span className="block font-normal text-muted-foreground text-xs">{props.title}</span>
            <span className="block truncate font-medium text-sm tabular-nums">{glance || "Tap to see your choices and details"}</span>
            </span>
          </span>
          <ChevronUp aria-hidden="true" className="shrink-0 text-muted-foreground" />
        </DrawerTrigger>
        <DrawerPopup showBar>
          <DrawerHeader>
            <PanelHeading {...props} as={DrawerTitle} />
          </DrawerHeader>
          <DrawerPanel>
            <PanelBody {...props} idPrefix="drawer" showBusiness={false} onChangeChosen={() => setOpen(false)} />
          </DrawerPanel>
        </DrawerPopup>
      </Drawer>
      {action}
      </div>
    </div>
  );
}
