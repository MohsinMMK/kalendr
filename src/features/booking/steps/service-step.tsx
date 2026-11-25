"use client";

import { TriangleAlert } from "lucide-react";
import type { MouseEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { RadioGroup } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import type { Service } from "@/lib/domain";

import { ServiceCard } from "../service-card";
import { ChoiceError, StepHeader } from "./step-header";

/** "What would you like to book?" Picture cards when any service has a picture, text rows when none do. */
export function ServiceStep({
  services,
  value,
  error,
  emptyMessage,
  onChange,
  onPick,
}: {
  services: Service[];
  value: string;
  error?: string;
  /** Said when nothing can be booked online for the earlier choices. */
  emptyMessage: string;
  onChange: (serviceId: string) => void;
  onPick: (event: MouseEvent<HTMLLabelElement>) => void;
}) {
  const layout = services.some((service) => service.imageUrl) ? "picture" : "text";
  const title = "What would you like to book?";
  return (
    <div className="flex flex-col gap-5">
      <StepHeader title={title} />
      {services.length > 0 ? (
        <RadioGroup
          id="service-options"
          tabIndex={-1}
          aria-label={title}
          aria-describedby={error ? "service-error" : undefined}
          value={value || null}
          onValueChange={(next) => onChange(next as string)}
          className={cn(
            "grid gap-3 outline-none",
            layout === "picture" ? "md:grid-cols-2 xl:grid-cols-3" : "md:grid-cols-2",
          )}
        >
          {services.map((service) => (
            <ServiceCard key={service.id} service={service} layout={layout} onPick={onPick} />
          ))}
        </RadioGroup>
      ) : (
        <Alert id="service-options" tabIndex={-1} role={undefined} variant="warning" className="outline-none">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{emptyMessage}</AlertDescription>
        </Alert>
      )}
      <ChoiceError id="service-error" error={error} />
    </div>
  );
}
