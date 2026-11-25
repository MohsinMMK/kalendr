"use client";

import { MapPin, Phone, PhoneIncoming, Video, House, type LucideIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { TextField } from "@/components/form-fields";
import { RadioGroup } from "@/components/ui/radio-group";
import type { Location } from "@/lib/domain";
import type { LocationOptionKind, ServiceLocationOption } from "@/lib/service-setup";

import { meetDetail, meetLabel } from "../booking-options";
import { RadioCard } from "../radio-card";
import { ChoiceError, StepHeader } from "./step-header";

const icons: Record<LocationOptionKind, LucideIcon> = {
  in_person: MapPin,
  we_call: PhoneIncoming,
  they_call: Phone,
  video: Video,
  their_address: House,
};

/**
 * "How would you like to meet?" Only shown when there is a real choice, or when the one way
 * needs an answer (the customer's own address). A single plain option is told, never asked.
 */
export function MeetStep({
  options,
  location,
  kind,
  detail,
  errors,
  onKindChange,
  onDetailChange,
  onPick,
  onSubmit,
}: {
  options: ServiceLocationOption[];
  location: Location | undefined;
  kind: LocationOptionKind | undefined;
  detail: string;
  errors: { kind?: string; detail?: string };
  onKindChange: (kind: LocationOptionKind) => void;
  onDetailChange: (detail: string) => void;
  onPick: (event: MouseEvent<HTMLLabelElement>) => void;
  /** Enter in the address box does what Continue does. */
  onSubmit?: () => void;
}) {
  const title = options.length > 1 ? "How would you like to meet?" : "Where should we come?";
  const branchName = location?.name ?? "us";
  const asksAddress = kind === "their_address";
  return (
    <div className="flex flex-col gap-5">
      <StepHeader title={title} />
      {options.length > 1 ? (
        <RadioGroup
          id="meet-options"
          tabIndex={-1}
          aria-label={title}
          aria-describedby={errors.kind ? "meet-error" : undefined}
          value={kind ?? null}
          onValueChange={(next) => onKindChange(next as LocationOptionKind)}
          className="grid gap-3 outline-none md:grid-cols-2"
        >
          {options.map((option) => {
            const Icon = icons[option.kind];
            return (
              <RadioCard
                key={`${option.kind}:${option.locationId ?? ""}`}
                id={`meet-${option.kind}`}
                value={option.kind}
                // Typing an address comes next, so a tap on that card must not skip ahead.
                onClick={option.kind === "their_address" ? undefined : onPick}
                className="bg-card"
              >
                <span className="flex min-w-0 flex-1 gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground" aria-hidden="true">
                    <Icon className="size-4.5" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium text-foreground">{meetLabel(option.kind)}</span>
                    <span className="wrap-break-word text-muted-foreground text-sm">{option.note ?? meetDetail(option.kind, branchName)}</span>
                  </span>
                </span>
              </RadioCard>
            );
          })}
        </RadioGroup>
      ) : null}
      <ChoiceError id="meet-error" error={errors.kind} />
      {asksAddress ? (
        <TextField
          id="meet-address"
          label="Your address"
          hint="Where we should come. Only the team sees this."
          autoComplete="street-address"
          enterKeyHint="next"
          value={detail}
          error={errors.detail}
          onChange={(event) => onDetailChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && onSubmit) {
              event.preventDefault();
              onSubmit();
            }
          }}
          required
        />
      ) : null}
    </div>
  );
}
