"use client";

import Link from "next/link";
import { EllipsisIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PersonAvatar } from "@/components/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { Menu, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { dayChipParts } from "@/lib/business-page";
import { cn } from "@/lib/utils";

/** A small rounded label for the top of a card: a rating, a price, a business name. */
export function Pill({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Badge variant="outline" className={cn("max-w-full rounded-full px-2", className)}>
      {children}
    </Badge>
  );
}

/** A free day that opens the booking on that day. */
export interface PersonCardDay {
  /** "YYYY-MM-DD" */
  key: string;
  href: string;
  /** Free times on that day, read out with the date. */
  count?: number;
}

/**
 * Free days as one row of two-line chips, weekday over date. The soonest day is filled, so the
 * quickest way to book stands out. The row scrolls sideways rather than wrapping.
 */
export function DayStrip({ days, todayKey, locale, label, className }: { days: PersonCardDay[]; todayKey: string; locale: string; label: string; className?: string }) {
  if (days.length === 0) return null;
  return (
    <ul aria-label={label} className={cn("-m-0.5 flex gap-1.5 overflow-x-auto p-0.5 [scrollbar-width:none]", className)}>
      {days.map((day, index) => {
        const parts = dayChipParts(day.key, todayKey, locale);
        const times = day.count ? `, ${day.count} free ${day.count === 1 ? "time" : "times"}` : "";
        return (
          <li key={day.key} className="min-w-11 max-w-16 flex-1">
            <Button
              variant={index === 0 ? "default" : "outline"}
              className="h-auto w-full flex-col gap-0 px-1 py-1.5 sm:h-auto"
              render={<Link href={day.href} />}
            >
              {/* The name starts with the visible words, so voice control can say what it sees. */}
              <span className="sr-only">Book </span>
              <span className="font-normal text-xs opacity-72">{parts.top}</span>
              <span className="font-semibold text-sm tabular-nums">{parts.day}</span>
              <span className="sr-only">, {parts.full}{times}</span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One person as a card, the same everywhere: the photo on the left; the name, what they do and their
 * labels (rating, price) beside it; one short line; then a row of free days and at most two buttons.
 * Everything secondary lives in the three-dot menu. A tap anywhere else on the card opens the person:
 * `onOpen` (a details drawer) when given, otherwise the profile page.
 */
export function PersonCard({
  name,
  role,
  image,
  profileHref,
  onOpen,
  pills,
  menu,
  line,
  children,
  footer,
}: {
  name: string;
  role?: string;
  image?: string | null;
  /** Opens on a tap anywhere on the card that is not a button. */
  profileHref?: string;
  /** Called on a tap anywhere on the card that is not a button, in place of opening `profileHref`. */
  onOpen?: () => void;
  /** The rating and other labels, shown under the name. */
  pills?: ReactNode;
  /** Menu items for the three-dot button. */
  menu?: ReactNode;
  /** One short line under the labels, such as "31 free times this week". */
  line?: ReactNode;
  /** The day strip, when there is one. */
  children?: ReactNode;
  /** Up to two buttons, shown side by side at equal width. */
  footer?: ReactNode;
}) {
  const stretched =
    "outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-ring";
  const opens = Boolean(onOpen || profileHref);
  return (
    <Card
      className={cn(
        "h-full transition-[border-color,box-shadow,translate] duration-200",
        opens && "hover:-translate-y-0.5 hover:border-primary/24 hover:shadow-md/5 motion-reduce:hover:translate-y-0",
      )}
    >
      <CardPanel className="flex flex-1 flex-col gap-4 p-4 sm:p-5">
        <div className="flex items-start gap-3.5">
          <PersonAvatar name={name} image={image} className="size-16 text-lg shadow-sm ring-2 ring-background outline outline-border/64 sm:size-18" />
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 break-words font-heading font-semibold text-base leading-snug">
                {profileHref ? (
                  <Link
                    href={profileHref}
                    className={stretched}
                    aria-haspopup={onOpen ? "dialog" : undefined}
                    onClick={(event) => {
                      // A plain tap opens the drawer; a new-tab click still opens the profile page.
                      if (!onOpen || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                      event.preventDefault();
                      onOpen();
                    }}
                  >
                    {name}
                  </Link>
                ) : onOpen ? (
                  <button type="button" onClick={onOpen} className={cn("text-start", stretched)}>
                    {name}
                  </button>
                ) : (
                  name
                )}
              </h3>
              {menu ? (
                <Menu>
                  <MenuTrigger render={<Button aria-label={`More about ${name}`} size="icon-sm" variant="ghost" className="relative z-1 -mt-1 -me-1.5 shrink-0" />}>
                    <EllipsisIcon aria-hidden="true" />
                  </MenuTrigger>
                  <MenuPopup align="end">{menu}</MenuPopup>
                </Menu>
              ) : null}
            </div>
            {role ? <p className="line-clamp-2 break-words text-muted-foreground text-sm">{role}</p> : null}
            {pills ? <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">{pills}</div> : null}
            {line ? <p className="text-muted-foreground text-xs tabular-nums">{line}</p> : null}
          </div>
        </div>
        {children ? <div className="relative z-1 w-fit max-w-full">{children}</div> : null}
        {footer ? <div className="relative z-1 mt-auto grid grid-cols-2 gap-2">{footer}</div> : null}
      </CardPanel>
    </Card>
  );
}
