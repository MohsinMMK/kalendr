"use client";

import { UsersRound } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerDescription,
  DrawerHeader,
  DrawerPanel,
  DrawerPopup,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Label } from "@/components/ui/label";
import { Radio } from "@/components/ui/radio-group";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { Practitioner } from "@/lib/domain";

type PersonProfile = Pick<Practitioner, "name" | "title" | "specialty" | "photoUrl" | "bio" | "qualifications" | "experienceYears" | "languages">;

export function hasProfile(person: PersonProfile): boolean {
  return Boolean(person.bio || person.qualifications || person.experienceYears || person.languages);
}

export function ProfileDetails({ person }: { person: PersonProfile }) {
  const facts = [
    person.qualifications ? { label: "Qualifications", value: person.qualifications } : null,
    person.experienceYears ? { label: "Experience", value: `${person.experienceYears} ${person.experienceYears === 1 ? "year" : "years"}` } : null,
    person.languages ? { label: "Languages", value: person.languages } : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null);
  return (
    <div className="flex flex-col gap-4">
      {person.bio ? <p className="whitespace-pre-line text-sm">{person.bio}</p> : null}
      {facts.length > 0 ? (
        <dl className="flex flex-col gap-2.5">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="text-muted-foreground text-xs">{fact.label}</dt>
              <dd className="text-sm">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/** "About {name}": a bottom drawer on phones and a dialog from 768px (the coss `p-drawer-12` pattern). */
function AboutPerson({ person }: { person: PersonProfile }) {
  const isPhone = useMediaQuery("(max-width: 767px)");
  const trigger = (
    <Button variant="link" size="sm" className="relative z-10 h-auto min-h-8 px-1 text-xs">
      About<span className="sr-only"> {person.name}</span>
    </Button>
  );
  const header = (
    <div className="flex items-center gap-3">
      <PersonAvatar name={person.name} image={person.photoUrl} className="size-12" />
      <div className="min-w-0">
        {isPhone ? <DrawerTitle>{person.name}</DrawerTitle> : <DialogTitle>{person.name}</DialogTitle>}
        {isPhone ? (
          <DrawerDescription>{[person.title, person.specialty].filter(Boolean).join(" · ")}</DrawerDescription>
        ) : (
          <DialogDescription>{[person.title, person.specialty].filter(Boolean).join(" · ")}</DialogDescription>
        )}
      </div>
    </div>
  );

  if (isPhone) {
    return (
      <Drawer>
        <DrawerTrigger render={trigger} />
        <DrawerPopup showBar>
          <DrawerHeader>{header}</DrawerHeader>
          <DrawerPanel>
            <ProfileDetails person={person} />
          </DrawerPanel>
        </DrawerPopup>
      </Drawer>
    );
  }
  return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>{header}</DialogHeader>
        <DialogPanel>
          <ProfileDetails person={person} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

interface PersonTileProps {
  value: string;
  id: string;
  /** Absent for "Anyone available". */
  person?: PersonProfile;
  title: string;
  description: ReactNode;
  onPick?: (event: MouseEvent<HTMLLabelElement>) => void;
}

/** A person (or "Anyone available") as a whole-tile radio, with their photo or initials. */
export function PersonTile({ value, id, person, title, description, onPick }: PersonTileProps) {
  let media: ReactNode;
  if (person) {
    media = <PersonAvatar name={person.name} image={person.photoUrl} className="size-14 text-base md:size-16" />;
  } else {
    media = (
      <span className="flex size-14 items-center justify-center rounded-full bg-accent text-muted-foreground md:size-16" aria-hidden="true">
        <UsersRound className="size-6" />
      </span>
    );
  }
  return (
    <div className="relative flex min-w-0 flex-col items-center gap-1 rounded-xl border bg-card p-3 pb-2 text-center transition-colors hover:bg-accent/40 has-focus-visible:ring-2 has-focus-visible:ring-ring has-data-checked:border-primary/48 has-data-checked:bg-accent/50 has-data-checked:ring-2 has-data-checked:ring-primary/48 md:p-4 md:pb-2.5">
      <Label
        onClick={onPick}
        className="flex w-full min-w-0 cursor-pointer flex-col items-center gap-2 font-normal before:absolute before:inset-0 before:rounded-xl"
      >
        <span className="sr-only"><Radio id={id} value={value} /></span>
        {media}
        <span className="flex min-w-0 max-w-full flex-col gap-0.5">
          <span className="wrap-break-word font-medium text-foreground text-sm">{title}</span>
          <span className="line-clamp-2 text-muted-foreground text-xs">{description}</span>
        </span>
      </Label>
      {person && hasProfile(person) ? <AboutPerson person={person} /> : <span className="min-h-8" aria-hidden="true" />}
    </div>
  );
}
