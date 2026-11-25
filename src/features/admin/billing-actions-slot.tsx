"use client";

import { CalendarPlus, Repeat } from "lucide-react";
import { useState } from "react";

import { ActionBar, type BarAction } from "@/components/action-bar";
import { SelectField, TextField } from "@/components/form-fields";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { toastManager } from "@/components/ui/toast";
import type { AdminTenantHealth } from "@/lib/admin-contracts";
import { planDefinitions, planKeys, type PlanKey } from "@/lib/entitlements";

import { adminActions, useAdminAction } from "./admin-api";
import { useAdminCan } from "./admin-role";
import { planLabel } from "./admin-format";
import { ReasonDialog } from "./reason-dialog";

type Open = "extend" | "plan" | null;

const planOptions = planKeys.map((key) => ({ value: key, label: planDefinitions[key].name }));

/** Billing and super operators only: give a business more trial days, or set its plan by hand. Both ask for a reason and are audited. */
export function BillingActionsSlot({ tenantId, billing }: { tenantId: string; billing: AdminTenantHealth["billing"] }) {
  const can = useAdminCan();
  const [open, setOpen] = useState<Open>(null);
  const [days, setDays] = useState("7");
  const [planKey, setPlanKey] = useState<string>("");
  const extend = useAdminAction((input: { days: number; reason: string }) => adminActions.extendTrial(tenantId, input));
  const change = useAdminAction((input: { planKey: string; reason: string }) => adminActions.changePlan(tenantId, input));
  if (!can.billing) return null;

  const dayCount = Number(days);
  const daysValid = Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 60;
  const current = (billing?.planKey ?? "") as PlanKey | "";
  const actions: BarAction[] = [
    { id: "extend-trial", label: "Extend trial", icon: <CalendarPlus />, variant: "default", priority: 2, onSelect: () => { setDays("7"); setOpen("extend"); } },
    { id: "change-plan", label: "Change plan", icon: <Repeat />, priority: 1, onSelect: () => { setPlanKey(current); setOpen("plan"); } },
  ];

  return (
    <Frame>
      <FrameHeader><FrameTitle>Billing actions</FrameTitle><FrameDescription>These change the plan without charging anyone. Each one is kept in the audit trail.</FrameDescription></FrameHeader>
      <FramePanel><ActionBar actions={actions} /></FramePanel>
      <ReasonDialog
        open={open === "extend"}
        onOpenChange={(next) => setOpen(next ? "extend" : null)}
        title="Extend the trial"
        description="Gives a trial or Free business more days of Growth, from now. Between 1 and 60 days."
        confirmLabel="Extend trial"
        onConfirm={async (reason) => {
          if (!daysValid) throw new Error("Enter a whole number of days from 1 to 60.");
          await extend.mutateAsync({ days: dayCount, reason });
          toastManager.add({ title: `Trial extended by ${dayCount} ${dayCount === 1 ? "day" : "days"}`, type: "success" });
        }}
      >
        <TextField label="Days" type="number" inputMode="numeric" min={1} max={60} step={1} value={days} onChange={(event) => setDays(event.target.value)} error={daysValid ? undefined : "Enter a whole number of days from 1 to 60."} />
      </ReasonDialog>
      <ReasonDialog
        open={open === "plan"}
        onOpenChange={(next) => setOpen(next ? "plan" : null)}
        title="Change the plan"
        description="Sets the plan by hand, for billing fixes. It does not charge or refund anyone: paid changes go through the payment provider."
        confirmLabel="Change plan"
        onConfirm={async (reason) => {
          if (!planKey) throw new Error("Choose a plan.");
          await change.mutateAsync({ planKey, reason });
          toastManager.add({ title: `Plan set to ${planLabel(planKey)}`, type: "success" });
        }}
      >
        <SelectField label="Plan" value={planKey} options={planOptions} placeholder="Choose a plan" onValueChange={setPlanKey} />
      </ReasonDialog>
    </Frame>
  );
}
