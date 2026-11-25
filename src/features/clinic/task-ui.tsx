"use client";

import type { ComponentProps, ReactNode } from "react";
import { Check } from "lucide-react";

import { RowButton } from "@/components/row-button";
import type { AppointmentStatus } from "@/lib/domain";
import { cn } from "@/lib/utils";

/** The badge tone for an appointment status, matching the schedule. */
export function appointmentStatusTone(status: AppointmentStatus) {
  if (status === "requested" || status === "reschedule_requested" || status === "pending_payment") return "attention" as const;
  if (status === "cancelled" || status === "no_show" || status === "declined" || status === "expired") return "danger" as const;
  if (status === "booked" || status === "checked_in") return "success" as const;
  return "neutral" as const;
}

/** Horizontal numbered progress. Labels of inactive steps collapse on phones so every step fits at 375px. */
export function TaskSteps({ label, steps, current, complete = false, className }: {
  label: string;
  steps: string[];
  current: number;
  complete?: boolean;
  className?: string;
}) {
  return (
    <ol aria-label={label} className={cn("flex w-full max-w-2xl items-center gap-2", className)}>
      {steps.map((step, index) => {
        const done = complete || index < current;
        const active = !complete && index === current;
        const last = index === steps.length - 1;
        return (
          <li key={step} aria-current={active ? "step" : undefined} className={cn("flex min-w-0 items-center gap-2", !last && "flex-1")}>
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
                done && "border-primary bg-primary text-primary-foreground",
                active && "border-primary text-primary",
                !done && !active && "text-muted-foreground",
              )}
            >
              {done ? <Check aria-hidden="true" className="size-3.5" /> : index + 1}
            </span>
            <span className={cn("whitespace-nowrap text-sm", active ? "font-medium" : "max-sm:sr-only", !active && !done && "text-muted-foreground")}>{step}</span>
            {last ? null : <span aria-hidden="true" className={cn("h-px min-w-3 flex-1", done ? "bg-primary" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}

/** A label and value inside a `<dl>`. */
export function Fact({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium wrap-break-word">{children}</dd>
    </div>
  );
}

/**
 * A selectable appointment opening for a slot grid. The name is the visible time and meta,
 * with the day read out first (hidden on screen, where the grid's heading shows it), so voice
 * control can say what it sees.
 */
export function OpeningButton({ day, time, meta, selected = false, className, ...props }: Omit<ComponentProps<typeof RowButton>, "children" | "aria-label"> & {
  /** "Mon, 31 Aug", read out before the time. Leave out when `time` already holds the date. */
  day?: string;
  time: ReactNode;
  meta: ReactNode;
  selected?: boolean;
}) {
  return (
    <RowButton
      variant="outline"
      aria-pressed={selected}
      className={cn("relative flex-col items-start gap-0.5 px-3 py-2", selected && "border-primary bg-accent", className)}
      {...props}
    >
      <span className="pe-5 font-medium tabular-nums">
        {day ? <><span className="sr-only">{day},</span>{" "}</> : null}
        {time}
      </span>{" "}
      <span className="text-xs text-muted-foreground">{meta}</span>
      {selected ? <Check aria-hidden="true" className="absolute end-2.5 top-2.5 size-4 text-primary" /> : null}
    </RowButton>
  );
}
