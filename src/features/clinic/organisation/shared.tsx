"use client";

import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { StaffApiError } from "../queries/http";

export { errorText, serverFieldErrors, formatDay, formatStamp, SecretRevealDialog } from "../developers/shared";

/** The plan prompt a refused enterprise feature shows, in the words the server gave. */
export function isPlanLimit(cause: unknown): boolean {
  return cause instanceof StaffApiError && cause.code === "plan_limit";
}

/** Loading, failed and ready, so each tab only writes its ready state. */
export function QueryState<T>({ query, label, children }: {
  query: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => Promise<unknown> };
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <div role="status" aria-label={`Loading ${label}`} className="flex flex-col gap-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
  if (query.isError || query.data === undefined) {
    const planLimited = isPlanLimit(query.error);
    return (
      <Alert variant={planLimited ? "info" : "error"}>
        <AlertTitle>{planLimited ? "Part of a higher plan" : `${label} could not be loaded`}</AlertTitle>
        <AlertDescription>
          <p>{query.error instanceof StaffApiError && query.error.message ? query.error.message : "Check your connection and try again."}</p>
          {planLimited ? null : <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}><RefreshCw aria-hidden="true" /> Retry</Button>}
        </AlertDescription>
      </Alert>
    );
  }
  return <>{children(query.data)}</>;
}
