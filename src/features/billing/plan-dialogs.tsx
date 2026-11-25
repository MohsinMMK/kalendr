"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useTerms } from "@/features/terms/business-profile-context";
import type { BillingPlanView, BillingState } from "@/lib/billing-contracts";

import { money, planName, shortDate } from "./billing-format";

/** Where the existing data export lives: the privacy centre (feature 7). */
export const dataExportHref = "/settings/privacy-requests";

export interface PendingChange {
  plan: BillingPlanView;
  kind: "upgrade" | "downgrade";
}

/** Confirms a change of plan: an upgrade applies now with a pro-rated charge, a downgrade waits for the period end. */
export function PlanChangeDialog({ state, change, now, pending, error, onConfirm, onClose }: {
  state: BillingState;
  change: PendingChange | null;
  now: Date;
  pending: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useTerms();
  const upgrade = change?.kind === "upgrade";
  const end = shortDate(state.plan.currentPeriodEnd, now);
  return (
    <Dialog open={change !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogPopup>
        {change ? (
          <>
            <DialogHeader>
              <DialogTitle>{upgrade ? `Upgrade to ${change.plan.name}?` : `Move to ${change.plan.name} at the period end?`}</DialogTitle>
              <DialogDescription>
                {upgrade
                  ? `You get ${change.plan.name} straight away. We charge the pro-rated difference for the rest of this period, and ${change.plan.name} renews at ${money(change.plan.priceMinor, change.plan.currency)} a month.`
                  : `You keep ${state.plan.name} until ${end || "the end of this period"}. Then ${change.plan.name} starts at ${money(change.plan.priceMinor, change.plan.currency)} a month. Nothing is deleted, and extra ${t.practitioner} calendars become read-only.`}
              </DialogDescription>
            </DialogHeader>
            {error ? <DialogPanel><Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert></DialogPanel> : null}
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={pending}>Not now</Button>
              <Button onClick={onConfirm} disabled={pending}>
                {pending ? <Spinner aria-hidden="true" /> : null}
                {upgrade ? "Upgrade now" : "Downgrade at period end"}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/** Cancelling takes two clicks: "Cancel plan", then this. Access stays until the period ends. */
export function CancelPlanDialog({ state, open, now, pending, error, onConfirm, onClose }: {
  state: BillingState;
  open: boolean;
  now: Date;
  pending: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useTerms();
  const end = shortDate(state.plan.currentPeriodEnd, now);
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel your {planName(state, state.plan.key)} plan?</AlertDialogTitle>
          <AlertDialogDescription>
            You keep everything in {state.plan.name} until {end || "the end of this period"}. Then you move to Free. Nothing is deleted, and extra {t.practitioner} calendars become read-only.{" "}
            <a className="font-medium text-foreground underline underline-offset-2" href={dataExportHref}>Download my data first</a>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <div className="px-6 pb-2"><Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>Keep my plan</AlertDialogClose>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? <Spinner aria-hidden="true" /> : null}
            Yes, cancel at period end
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
