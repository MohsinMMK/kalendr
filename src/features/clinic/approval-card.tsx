"use client";

import { useState } from "react";
import { Clock, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { declineReasonLabels, type DeclineReason } from "@/lib/approval";
import type { Appointment } from "@/lib/domain";

import { appointmentDateTime } from "./clinic-format";
import { DeclineDialog } from "./decline-dialog";
import { staffMutation } from "./staff-snapshot-provider";

type Busy = "approve" | "decline" | string | null;

/** What a quiet "this request is over" line says. Null for any other status. */
export function requestOutcome(appointment: Appointment): string | null {
  if (appointment.status === "declined") return appointment.declineReason ? `Declined: ${declineReasonLabels[appointment.declineReason]}` : "Declined";
  if (appointment.status === "expired") return "Expired: nobody answered before the start time";
  return null;
}

export function RequestOutcomeBanner({ appointment }: { appointment: Appointment }) {
  const outcome = requestOutcome(appointment);
  if (!outcome) return null;
  return <p role="status" className="flex items-center gap-2 rounded-lg border bg-muted/48 px-3 py-2 text-sm text-muted-foreground"><Clock aria-hidden="true" className="size-4 shrink-0" />{outcome}</p>;
}

/**
 * The card at the top of a request that is waiting for staff: approve the time asked for, approve one of the
 * other times the customer offered, or decline with a reason.
 */
export function ApprovalCard({ appointment, version, refresh }: {
  appointment: Appointment;
  /** The version staff are looking at. Absent when the snapshot has not loaded it. */
  version: number | undefined;
  refresh: () => Promise<void>;
}) {
  const t = useTerms();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [declining, setDeclining] = useState(false);
  const [declineError, setDeclineError] = useState("");
  const offered = (appointment.proposedStarts ?? []).filter((start) => Date.parse(start) !== Date.parse(appointment.startsAt));

  async function send(body: Record<string, unknown>, who: Exclude<Busy, null>): Promise<boolean> {
    if (!version) {
      const message = `This ${t.appointment} changed since you opened it. Refresh and try again.`;
      if (who === "decline") setDeclineError(message); else setError(message);
      return false;
    }
    setBusy(who);
    try {
      await staffMutation(`/api/staff/appointments/${appointment.id}`, "PATCH", { ...body, expectedVersion: version });
      await refresh();
      return true;
    } catch (cause: unknown) {
      const message = cause instanceof Error && cause.message ? cause.message : `Could not save this ${t.appointment}. Try again.`;
      if (who === "decline") setDeclineError(message); else setError(message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function approve(chosenStart?: string) {
    setError("");
    const ok = await send({ action: "approve", ...(chosenStart ? { chosenStart } : {}) }, chosenStart ?? "approve");
    if (ok) toastManager.add({ title: "Request approved", description: `The ${t.customer} will be told.`, type: "success" });
  }

  async function decline(input: { reason: DeclineReason; message: string }) {
    setDeclineError("");
    const ok = await send({ action: "decline", reason: input.reason, ...(input.message ? { message: input.message } : {}) }, "decline");
    if (ok) {
      setDeclining(false);
      toastManager.add({ title: "Request declined", description: `The ${t.customer} will be told.`, type: "success" });
    }
  }

  const working = busy !== null;
  return <section aria-label="Waiting for your approval">
    <Card className="border-warning/48">
      <CardPanel className="flex flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold">Waiting for your approval</h2>
          <p className="text-sm text-muted-foreground">The {t.customer} asked for <span className="font-medium text-foreground tabular-nums">{appointmentDateTime(appointment.startsAt)}</span>.</p>
        </div>
        {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="flex flex-nowrap gap-2">
          <Button className="min-w-0 flex-1" onClick={() => void approve()} loading={busy === "approve"} disabled={working && busy !== "approve"}>Approve</Button>
          <Button className="min-w-0 flex-1" variant="destructive-outline" onClick={() => { setDeclineError(""); setDeclining(true); }} disabled={working}>Decline</Button>
        </div>
        {offered.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">These also work for them</h3>
            <ul className="flex flex-col divide-y rounded-lg border">
              {offered.map((start) => (
                <li key={start} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span className="min-w-0 text-sm tabular-nums">{appointmentDateTime(start)}</span>
                  <Button size="sm" variant="outline" className="shrink-0" aria-label={`Approve this time: ${appointmentDateTime(start)}`} onClick={() => void approve(start)} loading={busy === start} disabled={working && busy !== start}>Approve this time</Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardPanel>
    </Card>
    <DeclineDialog open={declining} onOpenChange={setDeclining} pending={busy === "decline"} error={declineError} onSubmit={(input) => void decline(input)} />
  </section>;
}
