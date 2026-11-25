"use client";

import { Accessibility, MapPin } from "lucide-react";
import type { MouseEvent } from "react";

import { RadioGroup } from "@/components/ui/radio-group";
import type { Location } from "@/lib/domain";

import { useTerms } from "../../terms/business-profile-context";
import { RadioCard } from "../radio-card";
import { ChoiceError, StepHeader } from "./step-header";

/** "Which {location} suits you?" Text cards with the address; a tap chooses and moves on. */
export function LocationStep({
  locations,
  value,
  error,
  onChange,
  onPick,
}: {
  locations: Location[];
  value: string;
  error?: string;
  onChange: (locationId: string) => void;
  onPick: (event: MouseEvent<HTMLLabelElement>) => void;
}) {
  const t = useTerms();
  const title = `Which ${t.location} suits you?`;
  return (
    <div className="flex flex-col gap-5">
      <StepHeader title={title} />
      <RadioGroup
        id="location-options"
        tabIndex={-1}
        aria-label={title}
        aria-describedby={error ? "location-error" : undefined}
        value={value || null}
        onValueChange={(next) => onChange(next as string)}
        className="grid gap-3 outline-none md:grid-cols-2"
      >
        {locations.map((location) => (
          <RadioCard key={location.id} id={`location-${location.id}`} value={location.id} onClick={onPick} className="bg-card">
            <span className="flex min-w-0 flex-1 gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground" aria-hidden="true">
                <MapPin className="size-4.5" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-foreground">{location.name}</span>
                {location.address || location.city ? (
                  <span className="wrap-break-word text-muted-foreground text-sm">
                    {[location.address, location.city].filter(Boolean).join(", ")}
                  </span>
                ) : null}
                {location.accessibleEntrance ? (
                  <span className="mt-1 flex items-center gap-1.5 text-success-foreground text-xs">
                    <Accessibility className="size-3.5" aria-hidden="true" />
                    Step-free entrance
                  </span>
                ) : null}
              </span>
            </span>
          </RadioCard>
        ))}
      </RadioGroup>
      <ChoiceError id="location-error" error={error} />
    </div>
  );
}
