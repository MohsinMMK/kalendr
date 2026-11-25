"use client";

import { useEffect, useSyncExternalStore } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { startPixels } from "@/lib/embed/pixels";
import { readConsent, saveConsent, type ConsentChoice, type TrackingSettings } from "@/lib/embed/tracking";

const CONSENT_EVENT = "kalendr:consent-changed";

function subscribeToConsent(onChange: () => void): () => void {
  window.addEventListener(CONSENT_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CONSENT_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * The business's own tracking on its public booking pages (feature 52). Nothing loads until the visitor says yes: the banner
 * starts undecided, "No thanks" is as easy as "Allow", and the choice is kept in this browser for this business only.
 */
export function TrackingPixels({ clinicSlug, clinicName, settings }: { clinicSlug: string; clinicName: string; settings: TrackingSettings }) {
  // The choice lives in this browser, so the server render knows nothing and the banner appears once the page is in the browser.
  const choice = useSyncExternalStore(
    subscribeToConsent,
    () => readConsent(clinicSlug),
    () => "unread" as const,
  );

  useEffect(() => {
    if (choice !== "accepted") return undefined;
    return startPixels(settings);
  }, [choice, settings]);

  function decide(next: ConsentChoice): void {
    saveConsent(clinicSlug, next);
    // Scripts that already ran cannot be unloaded, so taking a yes back starts the page again without them.
    if (choice === "accepted" && next === "declined") window.location.reload();
    else window.dispatchEvent(new Event(CONSENT_EVENT));
  }

  if (choice === "unread") return null;
  if (choice === null) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-40 p-3 sm:p-4" role="region" aria-label="Analytics cookies">
        <Alert className="mx-auto max-w-xl bg-background shadow-lg">
          <AlertTitle>Allow analytics cookies?</AlertTitle>
          <AlertDescription>{clinicName} would like to measure how people use this booking page. Nothing is collected unless you allow it.</AlertDescription>
          <AlertAction className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => decide("declined")}>No thanks</Button>
            <Button size="sm" onClick={() => decide("accepted")}>Allow</Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="fixed bottom-1 left-2 z-30 min-h-11 text-muted-foreground text-xs underline underline-offset-2"
      onClick={() => decide(choice === "accepted" ? "declined" : "accepted")}
    >
      {choice === "accepted" ? "Analytics cookies: on. Turn off" : "Analytics cookies: off. Turn on"}
    </Button>
  );
}
