"use client";

import { CircleAlert, TriangleAlert } from "lucide-react";

import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Frame, FrameDescription, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Meter, MeterIndicator, MeterLabel, MeterTrack } from "@/components/ui/meter";
import type { BillingState } from "@/lib/billing-contracts";
import { cn } from "@/lib/utils";

import { usageView, type UsageView } from "./billing-format";

const overageOptions = [
  { value: "stop_marketing", label: "Stop marketing messages" },
  { value: "bill_overage", label: "Charge me per message" },
];

function UsageRow({ view }: { view: UsageView }) {
  const text = view.included === null ? view.status : `${view.used.toLocaleString("en-IN")} of ${view.included.toLocaleString("en-IN")} used`;
  return (
    <li className="flex flex-col gap-1.5 py-3">
      {view.included === null ? (
        <div className="flex items-baseline justify-between gap-3 text-sm"><span className="font-medium">{view.label}</span><span className="tabular-nums text-muted-foreground">{text}</span></div>
      ) : (
        <Meter value={view.used} min={0} max={Math.max(view.included, 1)} aria-label={view.label}>
          <div className="flex items-baseline justify-between gap-3">
            <MeterLabel>{view.label}</MeterLabel>
            <span className="text-sm tabular-nums text-muted-foreground">{text}</span>
          </div>
          <MeterTrack className="rounded-full">
            <MeterIndicator className={cn("rounded-full", view.level === "near" && "bg-warning", view.level === "over" && "bg-destructive")} />
          </MeterTrack>
        </Meter>
      )}
      {view.included !== null && view.status ? (
        <p className={cn("flex items-center gap-1.5 text-xs font-medium", view.level === "over" ? "text-destructive-foreground" : view.level === "near" ? "text-warning-foreground" : "text-muted-foreground")}>
          {view.level === "over" ? <CircleAlert aria-hidden="true" className="size-3.5" /> : view.level === "near" ? <TriangleAlert aria-hidden="true" className="size-3.5" /> : null}
          {view.status}
        </p>
      ) : null}
    </li>
  );
}

/** What has been used this month against what the plan includes, and the owner's choice for when it runs out. */
export function UsageMeters({ state, saving, error, onOverageChange }: {
  state: BillingState;
  saving: boolean;
  error: string;
  onOverageChange: (mode: BillingState["overageMode"]) => void;
}) {
  const views = state.usage.map(usageView);
  const anyOver = views.some((view) => view.level === "over" && view.metric !== "bookings" && view.metric !== "email");
  return (
    <Frame>
      <FrameHeader>
        <h3 className="font-semibold text-sm">Used this month</h3>
        <FrameDescription className="text-xs">Counts start again on the 1st. Email has no limit.</FrameDescription>
      </FrameHeader>
      <FramePanel>
        {views.length === 0 ? <p className="py-2 text-sm text-muted-foreground">Nothing has been used yet this month.</p> : (
          <ul className="flex list-none flex-col divide-y p-0">{views.map((view) => <UsageRow key={view.metric} view={view} />)}</ul>
        )}
      </FramePanel>
      <FramePanel className="flex flex-col gap-3">
        {anyOver ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>You have used all the messages your plan includes this month. {state.overageMode === "bill_overage" ? "Extra messages are charged to you." : "Marketing messages are stopped until next month."}</AlertDescription>
          </Alert>
        ) : null}
        <SelectField
          label="When messages run out"
          fieldClassName="max-w-sm"
          value={state.overageMode}
          onValueChange={(value) => { if (value === "stop_marketing" || value === "bill_overage") onOverageChange(value); }}
          options={overageOptions}
          disabled={saving}
          hint="Appointment confirmations and reminders are never stopped."
          error={error || undefined}
        />
      </FramePanel>
    </Frame>
  );
}
