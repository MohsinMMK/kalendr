"use client";

import { ArrowLeft } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

/** Where the arrow beside a step's title goes; the booking flow provides it on every step after the first. */
export const StepBackContext = createContext<{
  onBack: () => void;
  disabled?: boolean;
  /** The page shows the arrow in its own top row (below 1024px), so the title row leaves it out. */
  inTopRow?: boolean;
} | undefined>(undefined);

/**
 * The one title of a booking screen. Focus moves here after every step change
 * (`[data-step-heading]`), so screen-reader users hear where they are.
 */
/** The ghost back arrow with its tooltip. Renders nothing on the first screen. */
export function StepBackButton() {
  const back = useContext(StepBackContext);
  if (!back) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back"
            disabled={back.disabled}
            onClick={back.onBack}
            className="-ms-2 shrink-0 motion-safe:transition-transform motion-safe:hover:scale-110 motion-safe:active:scale-95"
          />
        }
      >
        <ArrowLeft aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>Back</TooltipPopup>
    </Tooltip>
  );
}

export function StepHeader({
  title,
  description,
  aside,
  titleId,
  hideTitle = false,
}: {
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  titleId?: string;
  /** Keeps the title for screen readers only; the back arrow still sits where it was. */
  hideTitle?: boolean;
}) {
  const back = useContext(StepBackContext);
  // Nothing visible (a hidden title, no arrow here, no aside): take the header out of the layout so it leaves no gap.
  const nothingShown = hideTitle && !aside && !description && (!back || back.inTopRow);
  return (
    <div className={nothingShown ? "sr-only" : "flex flex-col gap-1"}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* Below 1024px the arrow sits at the start of the business row above instead (see the booking flow). */}
          {back?.inTopRow ? null : <StepBackButton />}
          <h1
            id={titleId}
            data-step-heading
            tabIndex={-1}
            className={hideTitle ? "sr-only" : "min-w-0 font-heading font-semibold text-xl outline-none sm:text-2xl"}
          >
            {title}
          </h1>
        </div>
        {aside}
      </div>
      {description ? <p className="max-w-prose text-muted-foreground text-sm">{description}</p> : null}
    </div>
  );
}

/** A choice's error message, as a coss `FieldError` with a fixed id for `aria-describedby`. */
export function ChoiceError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <Field invalid>
      <FieldError id={id} match className="font-medium text-sm">
        {error}
      </FieldError>
    </Field>
  );
}
