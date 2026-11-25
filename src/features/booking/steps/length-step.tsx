"use client";

import { Clock3 } from "lucide-react";
import type { MouseEvent } from "react";

import { RadioGroup } from "@/components/ui/radio-group";
import type { Service } from "@/lib/domain";

import { getDurationLabel } from "../booking-format";
import { lengthPrice, serviceLengths } from "../booking-options";
import { RadioCard } from "../radio-card";
import { ChoiceError, StepHeader } from "./step-header";

/** "How long would you like?" One card per length with its own price. The usual length is chosen already. */
export function LengthStep({
  service,
  value,
  error,
  onChange,
  onPick,
}: {
  service: Service;
  /** The chosen length in minutes. */
  value: number;
  error?: string;
  onChange: (minutes: number) => void;
  onPick: (event: MouseEvent<HTMLLabelElement>) => void;
}) {
  const lengths = serviceLengths(service);
  const title = "How long would you like?";
  return (
    <div className="flex flex-col gap-5">
      <StepHeader title={title} description={`Times shown next fit the length you choose for ${service.name}.`} />
      <RadioGroup
        id="length-options"
        tabIndex={-1}
        aria-label={title}
        aria-describedby={error ? "length-error" : undefined}
        value={String(value)}
        onValueChange={(next) => onChange(Number(next))}
        className="grid gap-3 outline-none md:grid-cols-2"
      >
        {lengths.map((length) => {
          const price = lengthPrice(length, service, false);
          return (
            <RadioCard key={length.minutes} id={`length-${length.minutes}`} value={String(length.minutes)} onClick={onPick} className="bg-card">
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground" aria-hidden="true">
                  <Clock3 className="size-4.5" />
                </span>
                <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                  <span className="font-medium text-foreground tabular-nums">{getDurationLabel(length.minutes)}</span>
                  {price ? <span className="text-muted-foreground text-sm tabular-nums">{price}</span> : null}
                </span>
              </span>
            </RadioCard>
          );
        })}
      </RadioGroup>
      <ChoiceError id="length-error" error={error} />
    </div>
  );
}
