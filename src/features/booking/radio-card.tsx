"use client";

import type { MouseEvent, ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { Radio } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

/** A whole-card radio for use inside a coss `RadioGroup`. */
export function RadioCard({
  id,
  value,
  className,
  children,
  onClick,
}: {
  id?: string;
  value: string;
  className?: string;
  children: ReactNode;
  /** Runs on a click of the card, so a tap can choose and move on. */
  onClick?: (event: MouseEvent<HTMLLabelElement>) => void;
}) {
  return (
    <Label
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-start justify-between gap-3 rounded-xl border bg-background p-3.5 font-normal transition-colors hover:bg-accent/50 has-data-checked:border-primary/48 has-data-checked:bg-accent/50 sm:p-4",
        className,
      )}
    >
      {children}
      <Radio id={id} value={value} className="mt-0.5" />
    </Label>
  );
}
