"use client";

import Image from "next/image";
import { ChevronUp, PhoneIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import {
  Drawer,
  DrawerHeader,
  DrawerPanel,
  DrawerPopup,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

import { phoneHref } from "./booking-format";

export interface SummaryLine {
  id: string;
  icon: LucideIcon;
  label: string;
  value: string;
  meta?: string;
  numeric?: boolean;
  /** Shows a Change link that opens the screen where this choice is made. False when the choice was made for the customer. */
  changeable?: boolean;
  /** The chosen person, shown with their photo (or initials) beside the value. */
  person?: { name: string; photoUrl?: string | null };
}

/** The business's logo as a small rounded square. Nothing at all when it has no logo. */
export function BusinessLogo({ name, logoUrl, className }: { name: string; logoUrl?: string | null; className?: string }) {
  if (!logoUrl) return null;
  return (
    <Avatar className={cn("size-9 rounded-lg border bg-background", className)}>
      <AvatarImage src={logoUrl} alt={`${name} logo`} className="object-contain" />
    </Avatar>
  );
}

/** The business this booking is with: its name, and a call link when it has a phone number. */
export function BusinessLine({ name, phone, className }: { name: string; phone?: string | undefined; className?: string }) {
  return (
    <p className={cn("flex min-w-0 flex-wrap items-center gap-x-3 text-muted-foreground text-sm", className)}>
      <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
      {phone ? (
        <a href={phoneHref(phone)} className="inline-flex min-h-6 items-center gap-1 underline underline-offset-4">
          <PhoneIcon className="size-3.5" aria-hidden="true" />
          Call
        </a>
      ) : null}
    </p>
  );
}

interface BookingSummaryProps {
  /** Shown with the summary so the business stays visible on every step. */
  business?: { name: string; phone?: string | undefined };
  title: string;
  lines: SummaryLine[];
  /** The chosen service's picture, if it has one. */
  imageUrl?: string;
  imageAlt?: string;
  /** Called with the line's id when its Change link is used. */
  onChange?: (id: string) => void;
}

function SummaryList({
  lines,
  onChange,
  onChangeChosen,
}: {
  lines: SummaryLine[];
  onChange?: (id: string) => void;
  onChangeChosen?: () => void;
}) {
  return (
    <dl className="flex flex-col gap-3.5">
      {lines.map((line) => (
        // A <dl> group may hold only <dt> and <dd>: the icon sits in the term, the button in the description.
        <div key={line.id} className={cn("relative min-w-0 ps-6.5", line.changeable && onChange && "pe-16")}>
          <dt className="text-muted-foreground text-xs">
            <line.icon className="absolute start-0 top-0.5 size-4" aria-hidden="true" />
            {line.label}
          </dt>
          <dd className={cn("wrap-break-word font-medium text-sm", line.numeric && "tabular-nums")}>
            {line.value}
            {line.meta ? <span className="block font-normal text-muted-foreground text-xs tabular-nums">{line.meta}</span> : null}
            {line.changeable && onChange ? (
              <Button
                variant="link"
                size="sm"
                className="absolute end-0 top-0 h-auto min-h-6 px-0 text-xs"
                aria-label={`Change ${line.label.toLowerCase()}`}
                onClick={() => {
                  onChangeChosen?.();
                  onChange(line.id);
                }}
              >
                Change
              </Button>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** What has been chosen so far: a sticky card from 1024px, and below 1024px one line that opens a drawer. */
export function BookingSummaryCard({ business, title, lines, imageUrl, imageAlt = "", onChange }: BookingSummaryProps) {
  return (
    <Card render={<aside aria-label={title} />} className="sticky top-6 overflow-hidden max-lg:hidden">
      {imageUrl ? (
        <div className="relative aspect-video w-full overflow-hidden border-b bg-muted">
          <Image src={imageUrl} alt={imageAlt} fill unoptimized sizes="340px" className="object-cover" />
        </div>
      ) : null}
      <CardHeader className="p-5 pb-3">
        <CardTitle render={<h2 />} className="text-base">{title}</CardTitle>
        {business ? <BusinessLine name={business.name} phone={business.phone} className="mt-1" /> : null}
      </CardHeader>
      <CardPanel className="p-5 pt-0">
        {lines.length > 0 ? (
          <SummaryList lines={lines} onChange={onChange} />
        ) : (
          <p className="text-muted-foreground text-sm">Your choices show here as you go.</p>
        )}
      </CardPanel>
    </Card>
  );
}

export function BookingSummaryLine({ business, title, lines, imageUrl, imageAlt = "", onChange }: BookingSummaryProps) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  const glance = lines.map((line) => line.value).join(" · ");
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger
        render={
          <Button
            variant="outline"
            className="h-auto min-h-11 w-full justify-between gap-3 whitespace-normal py-2 text-start lg:hidden"
          />
        }
      >
        <span className="min-w-0">
          <span className="block font-normal text-muted-foreground text-xs">{title}</span>
          <span className="block truncate font-medium text-sm tabular-nums">{glance}</span>
        </span>
        <ChevronUp aria-hidden="true" className="text-muted-foreground" />
      </DrawerTrigger>
      <DrawerPopup showBar>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
        </DrawerHeader>
        <DrawerPanel className="flex flex-col gap-4">
          {business ? <BusinessLine name={business.name} phone={business.phone} /> : null}
          {imageUrl ? (
            <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-muted">
              <Image src={imageUrl} alt={imageAlt} fill unoptimized sizes="100vw" className="object-cover" />
            </div>
          ) : null}
          <SummaryList lines={lines} onChange={onChange} onChangeChosen={() => setOpen(false)} />
        </DrawerPanel>
      </DrawerPopup>
    </Drawer>
  );
}
