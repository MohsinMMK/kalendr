"use client";

import { RefreshCw } from "lucide-react";

import type { SelectOption } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";

import { isConflict } from "./availability-api";

/** Every IANA timezone the browser knows, with a short fallback where `Intl.supportedValuesOf` is missing. */
export function timezoneOptions(extra: readonly string[] = []): SelectOption[] {
  const known = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["Asia/Kolkata", "Asia/Dubai", "Europe/London", "America/New_York", "UTC"];
  return [...new Set([...extra, ...known])].map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }));
}

export function savedToast(title: string): void {
  toastManager.add({ title, type: "success" });
}

/** The message shown when a save is refused because someone else saved first. */
export function ConflictNotice({ onReload }: { onReload: () => void }) {
  return (
    <Alert variant="warning" role="alert">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>Someone else changed this. Reload to see their changes before you save yours.</span>
        <Button type="button" size="sm" variant="outline" onClick={onReload}><RefreshCw aria-hidden="true" /> Reload</Button>
      </AlertDescription>
    </Alert>
  );
}

export function describeFailure(cause: unknown, fallback: string): { conflict: boolean; message: string } {
  return { conflict: isConflict(cause), message: cause instanceof Error ? cause.message : fallback };
}
