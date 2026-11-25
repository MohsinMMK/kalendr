"use client";

import { Clock, TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { BillingState } from "@/lib/billing-contracts";

import { useBillingState } from "./billing-api";
import { daysUntil, shortDate } from "./billing-format";
import { requestBillingSection } from "./billing-navigation";

const dismissKeyPrefix = "kalendr:trial-banner:";

function dayKey(now: Date): string {
  return `${dismissKeyPrefix}${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function wasDismissed(now: Date): boolean {
  try { return window.localStorage.getItem(dayKey(now)) === "1"; } catch { return false; }
}

function remember(now: Date) {
  try { window.localStorage.setItem(dayKey(now), "1"); } catch { /* Storage can be blocked: the banner just comes back. */ }
}

/** Days left of a running trial when 3 or fewer remain, otherwise null. */
export function trialDaysLeft(state: BillingState, now: Date): number | null {
  if (state.plan.status !== "trialing" || state.plan.reason !== "trial") return null;
  const days = daysUntil(state.plan.trialEndsAt, now);
  return days !== null && days <= 3 ? days : null;
}

export function BillingBannerView({ state, now, onOpen }: { state: BillingState; now: Date; onOpen: () => void }) {
  const [dismissed, setDismissed] = useState(() => wasDismissed(now));
  const trialDays = trialDaysLeft(state, now);
  if (state.banner) {
    return (
      <div role="alert" className="sticky top-[calc(3.5rem+var(--support-banner-height,0px))] z-10 flex flex-wrap items-center justify-between gap-2 border-b border-destructive/32 bg-destructive/8 px-4 py-2 text-sm">
        <p className="flex min-w-0 items-start gap-2"><TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />
          <span>Your last payment didn&apos;t go through. Update your payment method by {shortDate(state.banner.graceEndsAt, now)} to keep your plan.</span></p>
        <Button size="sm" variant="outline" onClick={onOpen}>Update payment</Button>
      </div>
    );
  }
  if (trialDays === null || dismissed) return null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b bg-info/8 px-4 py-2 text-sm">
      <p className="flex min-w-0 items-start gap-2"><Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info-foreground" />
        <span>Your {state.plan.name} trial {trialDays === 0 ? "ends today" : `ends in ${trialDays} ${trialDays === 1 ? "day" : "days"}`}. Choose a plan to keep it.</span></p>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="outline" onClick={onOpen}>Choose plan</Button>
        <Button size="icon-sm" variant="ghost" aria-label="Hide until tomorrow" onClick={() => { remember(now); setDismissed(true); }}><X aria-hidden="true" /></Button>
      </div>
    </div>
  );
}

/** Owner-only strip under the header: a failed payment (stays until fixed) or a trial about to end (hidden for the day when dismissed). */
export function BillingBanners({ enabled }: { enabled: boolean }) {
  const query = useBillingState(enabled);
  const [now] = useState(() => new Date());
  if (!enabled || !query.data) return null;
  return <BillingBannerView state={query.data} now={now} onOpen={requestBillingSection} />;
}
