"use client";

import { Check, Plug } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { useTerms } from "@/features/terms/business-profile-context";
import type { BillingPlanView, BillingState } from "@/lib/billing-contracts";
import { cn } from "@/lib/utils";

import { planActionFor, planLines, priceText, type PlanAction } from "./billing-format";

/** The four plans side by side (stacked on a phone). Numbers come from the server, never from this file. */
export function PlansGrid({ state, busyPlan, onChoose }: {
  state: BillingState;
  /** The plan whose button was pressed and is still working. */
  busyPlan: string | null;
  onChoose: (plan: BillingPlanView, action: PlanAction) => void;
}) {
  const t = useTerms();
  return (
    <section aria-labelledby="plans-title" className="flex flex-col gap-3">
      <h3 id="plans-title" className="font-heading text-sm font-semibold">Compare plans</h3>
      {state.checkoutAvailable ? null : (
        <Alert variant="info">
          <Plug aria-hidden="true" />
          <AlertDescription id="checkout-unavailable">Payments for plans aren&apos;t connected yet. You can compare plans now, and choosing one opens once payments are connected.</AlertDescription>
        </Alert>
      )}
      <ul className="grid list-none gap-3 p-0 sm:grid-cols-2 xl:grid-cols-4">
        {state.plans.map((plan) => {
          const action = planActionFor(state, plan);
          const current = plan.key === state.plan.key;
          const needsPayments = action.kind === "checkout" || action.kind === "upgrade" || action.kind === "downgrade";
          const disabled = action.kind === "current" || action.kind === "scheduled" || action.kind === "none" || (needsPayments && !state.checkoutAvailable) || busyPlan !== null;
          return (
            <li key={plan.key} className="flex">
              <Card className={cn("w-full", current && "border-primary ring-1 ring-primary")} aria-current={current ? "true" : undefined}>
                <CardPanel className="flex h-full flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-heading text-base font-semibold">{plan.name}</h4>
                    {current ? <Badge variant="info">Your plan</Badge> : null}
                  </div>
                  <p className="text-sm font-medium tabular-nums">{priceText(plan)}</p>
                  <ul className="flex flex-1 list-none flex-col gap-1.5 p-0 text-sm text-muted-foreground">
                    {planLines(plan, t).map((line) => (
                      <li key={line} className="flex items-start gap-2"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" /><span>{line}</span></li>
                    ))}
                  </ul>
                  <Button
                    size="lg"
                    variant={action.kind === "upgrade" || action.kind === "checkout" ? "default" : "outline"}
                    disabled={disabled}
                    aria-describedby={needsPayments && !state.checkoutAvailable ? "checkout-unavailable" : undefined}
                    onClick={() => onChoose(plan, action)}
                  >
                    {action.label}
                    <span className="sr-only"> {plan.name}</span>
                  </Button>
                </CardPanel>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
