"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { toastManager } from "@/components/ui/toast";
import { useStepUp } from "@/features/clinic/step-up-dialog";
import type { BillingPlanView, BillingState } from "@/lib/billing-contracts";
import type { PlanKey } from "@/lib/entitlements";

import { useCancelPlan, useChangePlan, useResumePlan, useSaveBillingSettings, useStartCheckout, waitForState } from "./billing-api";
import type { PlanAction } from "./billing-format";
import { runCheckout, browserCheckoutDeps, type CheckoutDeps } from "./checkout";
import type { PendingChange } from "./plan-dialogs";

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

/** Everything the Plan and billing screen can do, with its pending and error state in one place. */
export function usePlanActions(state: BillingState, deps: CheckoutDeps = browserCheckoutDeps) {
  const client = useQueryClient();
  const { runWithStepUp } = useStepUp();
  const checkout = useStartCheckout();
  const change = useChangePlan();
  const cancel = useCancelPlan();
  const resume = useResumePlan();
  const settings = useSaveBillingSettings();
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [overageError, setOverageError] = useState("");

  async function startCheckout(plan: BillingPlanView) {
    if (plan.key === "free") return;
    setBusyPlan(plan.key);
    setError("");
    try {
      const outcome = await runCheckout(await checkout.mutateAsync(plan.key as Exclude<PlanKey, "free">), deps);
      if (outcome === "paid") {
        toastManager.add({ title: "Payment received. Updating your plan.", type: "info" });
        const active = await waitForState(client, (next) => next.plan.key === plan.key && next.plan.status === "active");
        toastManager.add(active
          ? { title: `You are on ${plan.name}. Thank you.`, type: "success" }
          : { title: "Payment received. Your plan will update in a minute.", description: "Refresh this page if it still shows the old plan.", type: "info" });
      } else if (outcome === "done") {
        await client.invalidateQueries({ queryKey: ["staff", "billing"] });
        toastManager.add({ title: "Your plan is updated.", type: "success" });
      }
    } catch (cause: unknown) {
      setError(message(cause, "Checkout could not start. Try again."));
    } finally {
      setBusyPlan(null);
    }
  }

  function choose(plan: BillingPlanView, action: PlanAction) {
    setError("");
    if (action.kind === "upgrade" || action.kind === "downgrade") setPendingChange({ plan, kind: action.kind });
    else if (action.kind === "cancel") setCancelOpen(true);
    else if (action.kind === "resume") void resumePlan();
    else if (action.kind === "checkout") void startCheckout(plan);
  }

  async function confirmChange() {
    if (!pendingChange) return;
    setError("");
    try {
      await change.mutateAsync(pendingChange.plan.key);
      toastManager.add({ title: pendingChange.kind === "upgrade" ? `You are on ${pendingChange.plan.name}.` : `${pendingChange.plan.name} starts when this period ends.`, type: "success" });
      setPendingChange(null);
    } catch (cause: unknown) {
      setError(message(cause, "The plan could not be changed. Try again."));
    }
  }

  async function confirmCancel() {
    setError("");
    try {
      await runWithStepUp(() => cancel.mutateAsync());
      toastManager.add({ title: "Your plan will end at the period end. Nothing is deleted.", type: "success" });
      setCancelOpen(false);
    } catch (cause: unknown) {
      setError(message(cause, "The plan could not be cancelled. Try again."));
    }
  }

  async function resumePlan() {
    try {
      await resume.mutateAsync();
      toastManager.add({ title: "Your plan will carry on.", type: "success" });
    } catch (cause: unknown) {
      setError(message(cause, "The plan could not be kept. Try again."));
    }
  }

  async function saveOverage(mode: BillingState["overageMode"]) {
    setOverageError("");
    try {
      await settings.mutateAsync({ overageMode: mode });
      toastManager.add({ title: "Saved.", type: "success" });
    } catch (cause: unknown) {
      setOverageError(message(cause, "That could not be saved. Try again."));
    }
  }

  async function saveGstin(billingGstin: string | null) {
    await settings.mutateAsync({ billingGstin });
    toastManager.add({ title: billingGstin ? "GSTIN saved." : "GSTIN removed.", type: "success" });
  }

  return {
    choose, busyPlan, error, overageError, saveOverage, saveGstin,
    pendingChange, closeChange: () => { setPendingChange(null); setError(""); }, confirmChange, changing: change.isPending,
    cancelOpen, openCancel: () => { setError(""); setCancelOpen(true); }, closeCancel: () => { setCancelOpen(false); setError(""); }, confirmCancel, cancelling: cancel.isPending,
    resumePlan, resuming: resume.isPending, savingSettings: settings.isPending,
  };
}
