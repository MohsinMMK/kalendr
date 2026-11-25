"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CalendarX, Copy, MessageSquare, UserRoundCog, X } from "lucide-react";
import { useState } from "react";

import { OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { StaffSnapshot } from "@/lib/staff-snapshot";

import { appointmentTime } from "./clinic-format";
import { type MutationResult, rescheduleFailure, useChangeAppointmentStatus, useRescheduleAppointment } from "./queries/appointment-mutations";
import { bulkSummary, runBulk } from "./queries/bulk";
import { staffKeys } from "./queries/keys";
import type { ListVisit } from "./schedule-list";
import { ScrollArea } from "@/components/ui/scroll-area";

type BulkDialog = "message" | "move" | "cancel" | null;

/** The quick reasons for cancelling a day's bookings, using the business's own word for the person who does the work. */
export const cancelReasonPresetsFor = (provider: string): string[] => [`${provider.charAt(0).toLocaleUpperCase("en")}${provider.slice(1)} is unwell`, "Staff member is off sick", "We have to close that day"];

/** The most recent version of one appointment, read when it is its turn so earlier changes in the same run have already counted. */
function currentVersion(snapshot: StaffSnapshot | undefined, id: string): number | null {
  return snapshot?.appointments.find((item) => item.id === id)?.version ?? null;
}

export function BulkBar({ count, canChange, onClear, onMessage, onMove, onCancel }: {
  count: number;
  canChange: boolean;
  onClear: () => void;
  onMessage: () => void;
  onMove: () => void;
  onCancel: () => void;
}) {
  const t = useTerms();
  return <div role="toolbar" aria-label="Actions for the selected visits" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
    <span className="me-1 font-medium text-sm tabular-nums" aria-live="polite">{count} selected</span>
    <Button size="sm" variant="outline" onClick={onMessage}><MessageSquare aria-hidden="true" /> Message</Button>
    {canChange ? <>
      <Button size="sm" variant="outline" onClick={onMove}><UserRoundCog aria-hidden="true" /> Move to another {t.practitioner}</Button>
      <Button size="sm" variant="destructive-outline" onClick={onCancel}><CalendarX aria-hidden="true" /> Cancel…</Button>
    </> : null}
    <Button size="sm" variant="ghost" className="ms-auto" onClick={onClear}><X aria-hidden="true" /> Clear</Button>
  </div>;
}

export function BulkDialogs({ dialog, onClose, selected, practitioners, onFinished }: {
  dialog: BulkDialog;
  onClose: () => void;
  selected: readonly ListVisit[];
  practitioners: readonly { id: string; name: string }[];
  /** Called with the ids that were not changed, so the screen can keep only those selected. */
  onFinished: (remaining: string[]) => void;
}) {
  const t = useTerms();
  const client = useQueryClient();
  const reschedule = useRescheduleAppointment();
  const status = useChangeAppointmentStatus();
  const [practitionerId, setPractitionerId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);

  function close() {
    if (pending) return;
    setFailures([]);
    setReason("");
    setPractitionerId("");
    onClose();
  }

  async function run(perform: (id: string, version: number) => Promise<MutationResult>, verb: Parameters<typeof bulkSummary>[1]) {
    setPending(true);
    setFailures([]);
    const names = new Map(selected.map((visit) => [visit.appointment.id, visit.patientName]));
    const outcome = await runBulk(
      selected.map((visit) => visit.appointment.id),
      async (id) => {
        const version = currentVersion(client.getQueryData<StaffSnapshot>(staffKeys.snapshot()), id);
        if (version === null) throw new Error("This appointment is not on the schedule any more.");
        return perform(id, version);
      },
      (error) => rescheduleFailure(error).description,
    );
    setPending(false);
    const summary = bulkSummary(outcome, verb);
    toastManager.add({ type: outcome.failed.length === 0 ? "success" : "warning", title: summary });
    if (outcome.failed.length > 0) {
      setFailures(outcome.failed.map((failure) => `${names.get(failure.id) ?? "A visit"}: ${failure.message}`));
      onFinished(outcome.failed.map((failure) => failure.id));
      return;
    }
    onFinished([]);
    close();
  }

  const people = selected.map((visit) => visit.patientName);

  return <>
    <Dialog open={dialog === "message"} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Message {selected.length} {selected.length === 1 ? t.customer : t.customers}</DialogTitle>
          <DialogDescription>Sending from here arrives with the messaging inbox. Until then, copy their numbers and use your own phone or WhatsApp.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ScrollArea className="flex h-auto! max-h-72 flex-col">
          <ul className="flex flex-col divide-y text-sm">
            {selected.map((visit) => <li key={visit.appointment.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate">{visit.patientName}<span className="text-muted-foreground"> · {appointmentTime(visit.appointment.startsAt)}</span></span>
              <a className="tabular-nums underline-offset-4 hover:underline" href={`tel:${visit.phone}`}>{visit.phone}</a>
            </li>)}
          </ul>
          </ScrollArea>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
          <Button onClick={() => {
            void navigator.clipboard.writeText(selected.map((visit) => `${visit.patientName}\t${visit.phone}`).join("\n")).then(
              () => toastManager.add({ type: "success", title: "Numbers copied" }),
              () => toastManager.add({ type: "error", title: "Could not copy the numbers" }),
            );
          }}><Copy aria-hidden="true" /> Copy names and numbers</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>

    <Dialog open={dialog === "move"} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogPopup>
        <form className="contents" onSubmit={(event) => {
          event.preventDefault();
          if (!practitionerId) return;
          void run(
            (id, version) => {
              const visit = selected.find((item) => item.appointment.id === id);
              if (!visit) return Promise.reject(new Error("Not selected."));
              return reschedule.mutateAsync({ kind: "move", appointmentId: id, startsAt: visit.appointment.startsAt, practitionerId, expectedVersion: version, notifyCustomer: true });
            },
            { past: "Moved", noun: t.appointment, nounPlural: t.appointments, couldNot: "could not be moved" },
          );
        }}>
          <DialogHeader>
            <DialogTitle>Move {selected.length} {selected.length === 1 ? t.appointment : t.appointments} to another {t.practitioner}</DialogTitle>
            <DialogDescription>The times stay the same. Any that clash with the new {t.practitioner}&rsquo;s day stay where they are, and you will see which.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <Field>
              <FieldLabel>{t.Practitioner}</FieldLabel>
              <OptionSelect aria-label={`Move to ${t.practitioner}`} size="default" value={practitionerId} onValueChange={setPractitionerId} options={[{ value: "", label: `Choose a ${t.practitioner}` }, ...practitioners.map((person) => ({ value: person.id, label: person.name }))]} />
            </Field>
            <FailureList items={failures} />
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" disabled={pending} />}>Not now</DialogClose>
            <Button type="submit" loading={pending} disabled={!practitionerId}>Move {selected.length}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>

    <Dialog open={dialog === "cancel"} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogPopup>
        <form className="contents" onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim().length < 3) return;
          void run(
            (id, version) => status.mutateAsync({ appointmentId: id, status: "cancelled", reason: reason.trim(), expectedVersion: version }),
            { past: "Cancelled", noun: t.appointment, nounPlural: t.appointments, couldNot: "could not be cancelled" },
          );
        }}>
          <DialogHeader>
            <DialogTitle>Cancel {selected.length} {selected.length === 1 ? t.appointment : t.appointments}?</DialogTitle>
            <DialogDescription>{people.slice(0, 3).join(", ")}{people.length > 3 ? ` and ${people.length - 3} more` : ""} will be told. This cannot be undone from here.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Reason</FieldLabel>
              <Textarea required minLength={3} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={`For example, the ${t.provider} is off sick`} />
            </Field>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Common reasons">
              {cancelReasonPresetsFor(t.provider).map((preset) => <Button key={preset} type="button" size="xs" variant="outline" onClick={() => setReason(preset)}>{preset}</Button>)}
            </div>
            <FailureList items={failures} />
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" disabled={pending} />}>Keep them</DialogClose>
            <Button type="submit" variant="destructive" loading={pending} disabled={reason.trim().length < 3}>Cancel {selected.length}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  </>;
}

function FailureList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return <div role="alert" className="rounded-lg border border-destructive/32 bg-destructive/4 p-3 text-sm">
    <p className="font-medium">These could not be changed and are still selected:</p>
    <ul className="mt-1 list-disc ps-5 text-muted-foreground">{items.map((item) => <li key={item}>{item}</li>)}</ul>
  </div>;
}
