"use client";

import { Ellipsis, Info, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Frame, FramePanel } from "@/components/ui/frame";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import type { BillingState } from "@/lib/billing-contracts";

import { daysUntil, hasPaidSubscription, money, planName, shortDate } from "./billing-format";

type Status = BillingState["plan"]["status"];

export function statusBadge(state: BillingState, now: Date): { label: string; variant: "info" | "success" | "warning" | "error" | "secondary" } {
  const { status, reason, currentPeriodEnd } = state.plan;
  if (status === "trialing" && reason === "trial") return { label: "Trial", variant: "info" };
  if (status === "active") return { label: "Active", variant: "success" };
  if (status === "past_due") return { label: "Payment failed", variant: "error" };
  if (status === "paused") return { label: "Paused", variant: "warning" };
  if (status === "cancelled" && reason === "paid") return { label: `Ends ${shortDate(currentPeriodEnd, now)}`, variant: "warning" };
  const labels: Partial<Record<Status, string>> = { cancelled: "Cancelled", trialing: "Trial ended" };
  return { label: labels[status] ?? "Free", variant: "secondary" };
}

/** The one sentence under the plan name: trial days left, the next renewal, or Free. */
export function planSummary(state: BillingState, now: Date): string {
  const { plan } = state;
  const name = plan.name;
  if (plan.status === "trialing" && plan.reason === "trial") {
    const days = daysUntil(plan.trialEndsAt, now);
    if (days === null) return `${name} trial, no card needed`;
    return `${name} trial, ${days === 0 ? "ends today" : `${days} ${days === 1 ? "day" : "days"} left`}, no card needed`;
  }
  if (plan.status === "trialing") return "Your trial ended. You are on the Free plan.";
  if (!hasPaidSubscription(state)) return "Free";
  const price = state.plans.find((item) => item.key === plan.key);
  const amount = price && price.priceMinor > 0 ? ` for ${money(price.priceMinor, state.currency)}` : "";
  if (plan.cancelAtPeriodEnd || plan.status === "cancelled") return `Ends on ${shortDate(plan.currentPeriodEnd, now)}`;
  if (plan.status === "past_due") return `Payment due${plan.graceEndsAt ? `, full service until ${shortDate(plan.graceEndsAt, now)}` : ""}`;
  return plan.currentPeriodEnd ? `Renews on ${shortDate(plan.currentPeriodEnd, now)}${amount}` : "Active";
}

export function PlanCard({ state, now, onCancel, onResume, resuming }: {
  state: BillingState;
  now: Date;
  onCancel: () => void;
  onResume: () => void;
  resuming: boolean;
}) {
  const { plan } = state;
  const badge = statusBadge(state, now);
  const ending = plan.cancelAtPeriodEnd || (plan.status === "cancelled" && plan.reason === "paid");
  const canCancel = hasPaidSubscription(state) && !ending && plan.status !== "past_due";
  return (
    <Frame>
      <FramePanel className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-heading text-lg font-semibold">{plan.name}</h3>
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{planSummary(state, now)}</p>
          </div>
          {canCancel ? (
            <Menu>
              <MenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label="More plan actions" />}><Ellipsis aria-hidden="true" /></MenuTrigger>
              <MenuPopup align="end"><MenuItem onClick={onCancel}>Cancel plan</MenuItem></MenuPopup>
            </Menu>
          ) : null}
        </div>
        {plan.pendingPlanKey && !ending ? (
          <Alert variant="info">
            <Info aria-hidden="true" />
            <AlertDescription>Changes to {planName(state, plan.pendingPlanKey)} on {shortDate(plan.currentPeriodEnd, now)}. You keep {plan.name} until then.</AlertDescription>
          </Alert>
        ) : null}
        {ending ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>Your plan ends on {shortDate(plan.currentPeriodEnd, now)}, then you move to Free. Nothing is deleted.</span>
              <Button size="sm" variant="outline" onClick={onResume} disabled={resuming}>Keep my plan</Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {plan.status === "past_due" ? (
          <Alert variant="error">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>Your last payment didn&apos;t go through. Update your payment method{plan.graceEndsAt ? ` by ${shortDate(plan.graceEndsAt, now)}` : ""} to keep your plan.</AlertDescription>
          </Alert>
        ) : null}
      </FramePanel>
    </Frame>
  );
}
