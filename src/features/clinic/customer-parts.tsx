"use client";

import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { secondFactorErrorCodes } from "@/lib/security-policy";
import type { TagColor } from "@/lib/customer-contracts";
import { cn } from "@/lib/utils";

import { StaffApiError } from "./queries/http";

/** Each tag colour as a soft chip. The name is always written out, so colour is never the only signal. */
const chipColors: Record<TagColor, string> = {
  gray: "bg-muted text-foreground",
  red: "bg-red-500/10 text-red-700 dark:text-red-300",
  orange: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  amber: "bg-amber-500/12 text-amber-800 dark:text-amber-300",
  green: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  teal: "bg-teal-500/10 text-teal-700 dark:text-teal-300",
  blue: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  violet: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  pink: "bg-pink-500/10 text-pink-700 dark:text-pink-300",
};

export const tagDots: Record<TagColor, string> = {
  gray: "bg-zinc-400", red: "bg-red-500", orange: "bg-orange-500", amber: "bg-amber-500", green: "bg-emerald-500",
  teal: "bg-teal-500", blue: "bg-blue-500", violet: "bg-violet-500", pink: "bg-pink-500",
};

export function TagChip({ name, color, className }: { name: string; color: TagColor; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", chipColors[color], className)}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", tagDots[color])} />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** True when the person closed the second-factor prompt or has none set up, so the screen says so instead of "failed". */
export function isStepUpDeclined(cause: unknown): boolean {
  return cause instanceof StaffApiError && (cause.code === secondFactorErrorCodes.stepUp || cause.code === secondFactorErrorCodes.pending || cause.code === secondFactorErrorCodes.required);
}

export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="error">
      <TriangleAlert aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{message}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
      </AlertDescription>
    </Alert>
  );
}

export function ListSkeleton({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3 p-4">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}
    </div>
  );
}

export function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

export function dateTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

export function Section({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium text-sm">{title}</h2>
          {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
