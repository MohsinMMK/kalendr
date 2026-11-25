"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

import { steps, type Step } from "./words";

const labels: Record<Step, { full: string; short: string }> = {
  upload: { full: "Upload", short: "Upload" },
  map: { full: "Match columns", short: "Match" },
  check: { full: "Check", short: "Check" },
  import: { full: "Import", short: "Import" },
};

/**
 * Where you are in the four steps. Every step behind you is a button when going back is allowed;
 * the current step is marked with aria-current, and a step ahead is plain text.
 */
export function ImportStepper({ current, canGoTo, onGo }: { current: Step; canGoTo: (step: Step) => boolean; onGo: (step: Step) => void }) {
  const at = steps.indexOf(current);
  return (
    <nav aria-label="Import steps">
      <ol className="flex w-full items-stretch gap-1">
        {steps.map((step, index) => {
          const done = index < at;
          const active = index === at;
          const clickable = done && canGoTo(step);
          const body = (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
                  active ? "border-primary bg-primary text-primary-foreground" : done ? "border-primary/40 bg-accent text-accent-foreground" : "bg-background text-muted-foreground",
                )}
              >
                {done ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className="min-w-0 truncate">
                <span className="sm:hidden">{labels[step].short}</span>
                <span className="max-sm:hidden">{labels[step].full}</span>
                {done ? <span className="sr-only"> (done)</span> : null}
              </span>
            </>
          );
          const shared = cn(
            "flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border px-2 text-sm font-medium outline-none sm:justify-start sm:px-3",
            active ? "border-primary/48 bg-accent/50 text-foreground" : "text-muted-foreground",
          );
          return (
            <li key={step} className="flex min-w-0 flex-1">
              {clickable ? (
                <button type="button" onClick={() => onGo(step)} className={cn(shared, "cursor-pointer text-foreground hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring")}>
                  {body}
                </button>
              ) : (
                <span aria-current={active ? "step" : undefined} className={shared}>{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
