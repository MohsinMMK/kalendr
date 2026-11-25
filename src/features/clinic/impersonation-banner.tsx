"use client";

import { Eye } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ImpersonationBanner as ImpersonationFacts } from "@/lib/admin-contracts";

import { staffMutation } from "./queries/http";

/** `27:41` for 1661 seconds. Never negative. */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What a screen reader hears: it changes once a minute and only in the last five, so it never chatters. */
function spokenRemaining(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 5 ? `Ends in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.` : "The session ends automatically after 30 minutes.";
}

/**
 * Shown on every staff screen while a Kalendr operator is "viewing as" the business. Sticky, bright, and counts
 * down to the end of the session; at zero the page reloads into whatever the session now allows (nothing).
 */
export function ImpersonationBanner({ impersonation, onExpire, onEnded }: {
  impersonation: ImpersonationFacts;
  onExpire?: () => void;
  onEnded?: () => void;
}) {
  const router = useRouter();
  const endsAtMs = new Date(impersonation.endsAt).getTime();
  // Null until the browser has its own clock, so the server's render and the first client render match.
  const [remaining, setRemaining] = useState<number | null>(null);
  const [ending, setEnding] = useState(false);
  const [failure, setFailure] = useState("");
  const element = useRef<HTMLDivElement>(null);
  const expired = useRef(false);
  const expire = useRef(onExpire);
  useEffect(() => { expire.current = onExpire; }, [onExpire]);

  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0 && !expired.current) {
        expired.current = true;
        (expire.current ?? (() => window.location.reload()))();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [endsAtMs]);

  // Sticky page headers sit just below the banner, whatever height it wraps to.
  useEffect(() => {
    const node = element.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const apply = () => document.documentElement.style.setProperty("--support-banner-height", `${node.offsetHeight}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--support-banner-height"); };
  }, []);

  async function endSession() {
    setEnding(true);
    setFailure("");
    try {
      await staffMutation("/api/admin/impersonation/end", "POST", {});
      (onEnded ?? (() => { router.push("/admin"); router.refresh(); }))();
    } catch (cause: unknown) {
      setFailure(cause instanceof Error ? cause.message : "The session could not be ended. Try again.");
      setEnding(false);
    }
  }

  return (
    <div ref={element} data-testid="impersonation-banner" className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-warning bg-warning px-4 py-2 text-sm text-black">
      <Eye aria-hidden="true" className="size-4 shrink-0" />
      <div role="status" aria-live="polite" className="min-w-0 flex-1 basis-60">
        <p className="font-medium">
          Viewing {impersonation.businessName} as Kalendr support. {impersonation.writeAccess ? "Changes are allowed and logged." : "Read-only."}{" "}
          <span aria-hidden="true">Ends in <span className="tabular-nums">{remaining === null ? "--:--" : formatCountdown(remaining)}</span>.</span>
        </p>
        <span className="sr-only">{remaining === null ? "" : spokenRemaining(remaining)}</span>
        {failure ? <p className="text-xs font-medium">{failure}</p> : null}
      </div>
      <Button size="sm" variant="outline" className="min-h-11 shrink-0 border-black/40 bg-white/70 text-black hover:bg-white sm:min-h-0" onClick={() => void endSession()} disabled={ending}>
        {ending ? <Spinner aria-hidden="true" /> : null}
        End session
      </Button>
    </div>
  );
}
