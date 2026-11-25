"use client";

import { CircleAlert, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

export function errorText(error: unknown, fallback = "This could not be loaded."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function LoadingRows({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-11 w-full" />)}
    </div>
  );
}

/** What went wrong in plain words, and a way to try again. */
export function ErrorPanel({ error, onRetry, retrying = false }: { error: unknown; onRetry: () => void; retrying?: boolean }) {
  return (
    <Alert variant="error">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>That did not load</AlertTitle>
      <AlertDescription>{errorText(error)}</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          <RefreshCw aria-hidden="true" />
          Try again
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function EmptyPanel({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return (
    <Empty className="py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}

/** Page title block used by every operator screen. */
export function ScreenHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="font-heading text-xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {actions}
    </header>
  );
}
