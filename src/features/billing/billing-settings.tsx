"use client";

import { CreditCard, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { useCatalogLookups } from "@/features/clinic/clinic-catalog";

import { previewBillingState, useBillingState } from "./billing-api";
import { GstinForm, InvoicesTable } from "./billing-details";
import { PlanCard } from "./plan-card";
import { CancelPlanDialog, PlanChangeDialog } from "./plan-dialogs";
import { PlansGrid } from "./plans-grid";
import { UsageMeters } from "./usage-meters";
import { usePlanActions } from "./use-plan-actions";
import type { BillingState } from "@/lib/billing-contracts";
import type { CheckoutDeps } from "./checkout";

/** Settings → Plan and billing. Owners only; the server checks again on every request. */
export function BillingSettings({ checkoutDeps, now }: { checkoutDeps?: CheckoutDeps; now?: Date }) {
  const { database } = useCatalogLookups();
  const query = useBillingState(database);
  if (!database) return <BillingBody state={previewBillingState()} preview checkoutDeps={checkoutDeps} now={now} />;
  if (query.isPending) {
    return (
      <div role="status" aria-label="Loading your plan" className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" /><Skeleton className="h-10 w-64" /><Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <Alert variant="error">
        <TriangleAlert aria-hidden="true" />
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>{query.error instanceof Error ? query.error.message : "Your plan could not be loaded."}</span>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <BillingBody state={query.data} checkoutDeps={checkoutDeps} now={now} />;
}

function BillingBody({ state, preview = false, checkoutDeps, now }: { state: BillingState; preview?: boolean; checkoutDeps?: CheckoutDeps; now?: Date }) {
  const [clock] = useState(() => now ?? new Date());
  const actions = usePlanActions(state, checkoutDeps);
  return (
    <div className="flex flex-col gap-4">
      {preview ? (
        <Alert variant="info" role="note">
          <CreditCard aria-hidden="true" />
          <AlertDescription>This is sample data. Plans cannot be changed in the preview.</AlertDescription>
        </Alert>
      ) : null}
      {actions.error && !actions.pendingChange && !actions.cancelOpen ? <Alert variant="error"><AlertDescription>{actions.error}</AlertDescription></Alert> : null}
      <PlanCard state={state} now={clock} onCancel={actions.openCancel} onResume={() => void actions.resumePlan()} resuming={actions.resuming} />
      <Tabs defaultValue="plans">
        <TabsList variant="underline" aria-label="Plan and billing">
          <TabsTab value="plans">Plans</TabsTab>
          <TabsTab value="usage">Usage</TabsTab>
          <TabsTab value="billing">Invoices</TabsTab>
        </TabsList>
        <TabsPanel value="plans" className="pt-4">
          <PlansGrid state={state} busyPlan={actions.busyPlan} onChoose={actions.choose} />
        </TabsPanel>
        <TabsPanel value="usage" className="pt-4">
          <UsageMeters state={state} saving={actions.savingSettings || preview} error={actions.overageError} onOverageChange={(mode) => void actions.saveOverage(mode)} />
        </TabsPanel>
        <TabsPanel value="billing" className="flex flex-col gap-4 pt-4">
          <GstinForm state={state} onSave={preview ? async () => { throw new Error("The preview cannot save billing details."); } : actions.saveGstin} />
          <InvoicesTable state={state} now={clock} />
        </TabsPanel>
      </Tabs>
      <PlanChangeDialog state={state} change={actions.pendingChange} now={clock} pending={actions.changing} error={actions.error} onConfirm={() => void actions.confirmChange()} onClose={actions.closeChange} />
      <CancelPlanDialog state={state} open={actions.cancelOpen} now={clock} pending={actions.cancelling} error={actions.error} onConfirm={() => void actions.confirmCancel()} onClose={actions.closeCancel} />
    </div>
  );
}
