"use client";

import type { MouseEvent } from "react";

import { RadioGroup } from "@/components/ui/radio-group";
import type { Practitioner } from "@/lib/domain";

import { useTerms } from "../../terms/business-profile-context";
import { Skeleton } from "@/components/ui/skeleton";
import { PersonTile } from "../person-tile";
import { ChoiceError, StepHeader } from "./step-header";

/** "Who would you like to see?" "Anyone available" first, then one tile per person. */
export function ProviderStep({
  people,
  value,
  error,
  onChange,
  onPick,
  nextFree,
}: {
  people: Practitioner[];
  value?: string;
  error?: string;
  onChange: (practitionerId: string) => void;
  onPick: (event: MouseEvent<HTMLLabelElement>) => void;
  /** Free times in the next 14 days, already worded. `loading` shows a placeholder line; null keeps the plain descriptions. */
  nextFree?: { earliest: string | null; byPerson: Record<string, string>; loading?: boolean } | null;
}) {
  const t = useTerms();
  const loading = Boolean(nextFree?.loading);
  const loadingLine = <Skeleton className="mt-1 h-3.5 w-28" aria-label="Checking times" />;
  const title = "Who would you like to see?";
  return (
    <div className="flex flex-col gap-5">
      <StepHeader title={title} />
      <RadioGroup
        id="practitioner-options"
        tabIndex={-1}
        aria-label={title}
        aria-describedby={error ? "practitioner-error" : undefined}
        value={value ?? null}
        onValueChange={(next) => onChange(next as string)}
        className="grid grid-cols-2 gap-3 outline-none md:grid-cols-3 xl:grid-cols-4"
      >
        <PersonTile
          id="practitioner-first-available"
          value="first_available"
          title="Anyone available"
          description={loading ? loadingLine : nextFree ? (nextFree.earliest ? `Earliest: ${nextFree.earliest}` : "No openings soon") : `Earliest time with any ${t.provider}`}
          onPick={onPick}
        />
        {people.map((person) => (
          <PersonTile
            key={person.id}
            id={`practitioner-${person.id}`}
            value={person.id}
            person={person}
            title={person.name}
            description={loading ? loadingLine : nextFree ? (nextFree.byPerson[person.id] ? `Next free: ${nextFree.byPerson[person.id]}` : "No openings soon") : person.specialty || person.title}
            onPick={onPick}
          />
        ))}
      </RadioGroup>
      <ChoiceError id="practitioner-error" error={error} />
    </div>
  );
}
