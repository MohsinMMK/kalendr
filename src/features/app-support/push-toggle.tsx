"use client";

import { BellOff, BellRing } from "lucide-react";

import { Button } from "@/components/ui/button";

import { usePush } from "./use-push";

const MESSAGES = {
  unsupported: "This browser can't show alerts when the app is closed. On an iPhone, add the app to your home screen first.",
  unavailable: "Alerts on this device are not set up on this server yet.",
  blocked: "Alerts are blocked for this site. Allow notifications in your browser's site settings to turn them on.",
} as const;

/**
 * One button to turn alerts on for this device, asked for only when pressed and never on first load.
 * `compact` is for a header: when alerts can't be used here it shows nothing rather than a sentence.
 */
export function PushToggle({ endpoint, onLabel = "Turn off alerts on this device", offLabel = "Turn on alerts on this device", compact = false }: { endpoint: string; onLabel?: string; offLabel?: string; compact?: boolean }) {
  const { state, error, enable, disable } = usePush(endpoint);
  if (compact && state in MESSAGES) return null;
  return (
    <div className="flex flex-col items-start gap-2">
      {state === "on" ? (
        <Button variant="outline" size="sm" onClick={() => void disable()}><BellOff aria-hidden="true" /> {onLabel}</Button>
      ) : state === "off" || state === "checking" ? (
        <Button size="sm" disabled={state === "checking"} onClick={() => void enable()}><BellRing aria-hidden="true" /> {offLabel}</Button>
      ) : (
        <p className="text-sm text-muted-foreground">{MESSAGES[state]}</p>
      )}
      {state === "on" && !compact ? <p className="text-xs text-muted-foreground">Alerts are on for this device.</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
    </div>
  );
}
