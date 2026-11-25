"use client";

import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { useTerms } from "@/features/terms/business-profile-context";
import type { BillingPlanView, PlanLimitDetails } from "@/lib/billing-contracts";

import { priceText } from "./billing-format";
import { upgradeMessage } from "./upgrade-copy";

/**
 * "Your Starter plan includes 3 staff calendars. Growth includes 10." One dialog for every refusal the server answers with
 * `plan_limit`. Owners can go to the plans; everyone else is told whom to ask. Prices appear only when the owner's plans loaded.
 */
export function UpgradeDialog({ details, plans, isOwner, onClose, onSeePlans }: {
  details: PlanLimitDetails | null;
  /** The plans from the server. Empty when they are not available to this person. */
  plans: readonly BillingPlanView[];
  isOwner: boolean;
  onClose: () => void;
  onSeePlans: () => void;
}) {
  const t = useTerms();
  const required = details?.requiredPlan ? plans.find((plan) => plan.key === details.requiredPlan) : undefined;
  return (
    <Dialog open={details !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup>
        {details ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><Sparkles aria-hidden="true" className="size-4 text-primary" /> This needs a bigger plan</DialogTitle>
              <DialogDescription>{upgradeMessage(details, plans, { practitioner: t.practitioner, practitioners: t.practitioners })}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="text-sm">
              {required ? <p><span className="font-medium">{required.name}</span> is {priceText(required)}.</p> : null}
              {isOwner
                ? <p className="mt-1 text-muted-foreground">Nothing is deleted if you stay on your current plan. You can change plan any time.</p>
                : <p className="mt-1 text-muted-foreground">Ask the owner of the {t.business} to change the plan.</p>}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>{isOwner ? "Not now" : "Got it"}</Button>
              {isOwner ? <Button onClick={onSeePlans}>See plans</Button> : null}
            </DialogFooter>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
