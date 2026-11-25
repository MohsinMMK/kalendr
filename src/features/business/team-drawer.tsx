"use client";

import { SearchIcon, SearchXIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { matchesSearch } from "@/lib/business-page";
import type { Practitioner, Service } from "@/lib/domain";
import type { RatingSummaries } from "@/lib/reviews";

import { useTerms } from "../terms/business-profile-context";
import { PersonDrawer } from "./person-drawer";
import { RatingLine } from "./ratings";

const ALL = "all";

/** What a person is known for: their specialty, else their title. */
function roleOf(person: Practitioner): string {
  return (person.specialty || person.title || "").trim();
}

/** Everyone on the team in a right-side drawer, with a search box and role filters. */
export function TeamDrawer({
  open,
  onOpenChange,
  people,
  slug,
  locale,
  ratings,
  services,
  freeDays,
  todayKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already in popularity order. */
  people: Practitioner[];
  slug: string;
  locale: string;
  ratings: RatingSummaries | undefined;
  services: Service[];
  freeDays: Record<string, string[]>;
  todayKey: string;
}) {
  const t = useTerms();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState(ALL);
  const roles = useMemo(() => [...new Set(people.map(roleOf).filter(Boolean))], [people]);
  const shown = people.filter(
    (person) => (role === ALL || roleOf(person) === role) && matchesSearch(query, person.name, person.title, person.specialty),
  );
  return (
    <Drawer open={open} onOpenChange={onOpenChange} position="right">
      <DrawerPopup showCloseButton variant="inset">
        <DrawerHeader>
          <DrawerTitle className="font-heading text-xl">All {t.providers}</DrawerTitle>
        </DrawerHeader>
        <DrawerPanel className="flex flex-col gap-4">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${t.providers}`}
              aria-label={`Search ${t.providers}`}
            />
          </InputGroup>
          {roles.length > 1 ? (
            <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <ToggleGroup
                aria-label={`Filter ${t.providers}`}
                value={[role]}
                onValueChange={(value) => setRole(value[0] ?? ALL)}
                variant="outline"
                className="flex-nowrap gap-2 *:rounded-full! *:border-s! *:before:rounded-full!"
              >
                {[ALL, ...roles].map((item) => (
                  <ToggleGroupItem key={item} value={item} size="sm" className="shrink-0">
                    {item === ALL ? "All" : item}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          ) : null}
          <p className="sr-only" aria-live="polite">{`${shown.length} ${t.providers} shown`}</p>
          {shown.length > 0 ? (
            <ul className="-mx-2 flex flex-col">
              {shown.map((person) => (
                <li key={person.id}>
                  <TeamRow
                    person={person}
                    slug={slug}
                    locale={locale}
                    rating={ratings?.byPractitioner[person.id]}
                    services={services}
                    days={freeDays[person.id] ?? []}
                    todayKey={todayKey}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <Empty className="rounded-xl border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchXIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No {t.providers} match</EmptyTitle>
                <EmptyDescription>Try another name or clear the filter.</EmptyDescription>
              </EmptyHeader>
              <Button
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setRole(ALL);
                }}
              >
                Clear search
              </Button>
            </Empty>
          )}
        </DrawerPanel>
      </DrawerPopup>
    </Drawer>
  );
}

function TeamRow({
  person,
  slug,
  locale,
  rating,
  services,
  days,
  todayKey,
}: {
  person: Practitioner;
  slug: string;
  locale: string;
  rating: RatingSummaries["business"] | undefined;
  services: Service[];
  days: string[];
  todayKey: string;
}) {
  const [open, setOpen] = useState(false);
  const role = [person.title, person.specialty].filter(Boolean).join(" · ");
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-start outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PersonAvatar name={person.name} image={person.photoUrl} className="size-11 shrink-0 text-sm" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium text-sm">{person.name}</span>
          {role ? <span className="truncate text-muted-foreground text-xs">{role}</span> : null}
          <RatingLine summary={rating} className="text-xs" />
        </span>
      </button>
      <PersonDrawer open={open} onOpenChange={setOpen} person={person} slug={slug} locale={locale} rating={rating} services={services} days={days} todayKey={todayKey} />
    </>
  );
}
