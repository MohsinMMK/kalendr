"use client";

import { TriangleAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTerms } from "@/features/terms/business-profile-context";
import { type BookingRow, type BulkResult } from "@/lib/bookings-list";
import { delayOptions, quickMessageLabel } from "@/lib/quick-messages";

import { useCancelPresets } from "./bookings-data";
import { appointmentDateTime } from "./clinic-format";

export interface ActionDialogShared { pending: boolean; error: string; onClose: () => void }

function ActionDialog({ title, description, confirmLabel, destructive, canSubmit = true, pending, error, onClose, onSubmit, children }: ActionDialogShared & {
  title: string; description: ReactNode; confirmLabel: string; destructive?: boolean; canSubmit?: boolean; onSubmit: () => void; children: ReactNode;
}) {
  function submit(event: FormEvent) { event.preventDefault(); if (canSubmit && !pending) onSubmit(); }
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogPopup showCloseButton={!pending}>
        <form onSubmit={submit} className="contents">
          <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
            {children}
          </DialogPanel>
          <DialogFooter>
            <DialogClose disabled={pending} render={<Button type="button" variant="ghost" />}>Back</DialogClose>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={!canSubmit} loading={pending}>{confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Giving bookings to another person at the same time. One booking or many. */
export function ReassignDialog({ count, people, onSubmit, ...shared }: ActionDialogShared & { count: number; people: { value: string; label: string }[]; onSubmit: (practitionerId: string) => void }) {
  const t = useTerms();
  const [who, setWho] = useState<string | null>(null);
  return (
    <ActionDialog {...shared} title={`Move to another ${t.practitioner}`} confirmLabel="Move" canSubmit={Boolean(who)} onSubmit={() => who && onSubmit(who)}
      description={`${plural(count, t.appointment, t.appointments)} will move to the ${t.practitioner} you choose, at the same time. Both ${t.practitioners} and the ${t.customer} are told. If they are busy, that one stays where it is.`}>
      <Field>
        <FieldLabel>{t.Practitioner}</FieldLabel>
        <Select value={who} onValueChange={(next) => { if (next) setWho(String(next)); }} items={people} disabled={shared.pending}>
          <SelectTrigger aria-label={`New ${t.practitioner}`} size="lg"><SelectValue placeholder={`Choose a ${t.practitioner}`} /></SelectTrigger>
          <SelectPopup>{people.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
        </Select>
      </Field>
    </ActionDialog>
  );
}

const NO_REASON = "none";

/** Cancelling several bookings with one reason from the business's list. */
export function BulkCancelDialog({ count, onSubmit, ...shared }: ActionDialogShared & { count: number; onSubmit: (input: { presetId?: string; notifyCustomers: boolean }) => void }) {
  const t = useTerms();
  const { presets, loading, failed } = useCancelPresets(true);
  const [presetId, setPresetId] = useState(NO_REASON);
  const [notify, setNotify] = useState(true);
  const items = [{ value: NO_REASON, label: "No specific reason" }, ...presets.map((preset) => ({ value: preset.id, label: preset.label }))];
  return (
    <ActionDialog {...shared} title={`Cancel ${plural(count, t.appointment, t.appointments)}`} confirmLabel="Cancel them" destructive
      onSubmit={() => onSubmit({ ...(presetId !== NO_REASON ? { presetId } : {}), notifyCustomers: notify })}
      description={`This frees the times. Choose a reason to keep on record${notify ? ` and to tell the ${t.customers}` : ""}.`}>
      <Field>
        <FieldLabel>Reason</FieldLabel>
        <Select value={presetId} onValueChange={(next) => { if (next) setPresetId(String(next)); }} items={items} disabled={shared.pending || loading}>
          <SelectTrigger aria-label="Reason" size="lg"><SelectValue placeholder={loading ? "Loading reasons…" : "No specific reason"} /></SelectTrigger>
          <SelectPopup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
        </Select>
        {failed ? <p role="status" className="text-xs text-muted-foreground">Your reasons could not be loaded. You can still cancel without one.</p> : null}
      </Field>
      <Label className="min-h-11 sm:min-h-0"><Checkbox checked={notify} onCheckedChange={(next) => setNotify(next === true)} disabled={shared.pending} />Tell the {t.customers}</Label>
    </ActionDialog>
  );
}

const messageItems = [{ value: "call_us", label: quickMessageLabel("call_us") }, { value: "running_late", label: quickMessageLabel("running_late") }];
const delayItems = delayOptions.map((minutes) => ({ value: String(minutes), label: `${minutes} minutes` }));

/** One of the ready-made messages, sent to the customers of the chosen bookings. */
export function BulkMessageDialog({ count, onSubmit, ...shared }: ActionDialogShared & { count: number; onSubmit: (input: { messageKind: "call_us" | "running_late"; delayMinutes?: number }) => void }) {
  const t = useTerms();
  const [kind, setKind] = useState<"call_us" | "running_late">("call_us");
  const [minutes, setMinutes] = useState("15");
  return (
    <ActionDialog {...shared} title="Send a message" confirmLabel="Send" onSubmit={() => onSubmit({ messageKind: kind, ...(kind === "running_late" ? { delayMinutes: Number(minutes) } : {}) })}
      description={`Each ${t.customer} of the ${plural(count, t.appointment, t.appointments)} you chose gets this message.`}>
      <Field>
        <FieldLabel>Message</FieldLabel>
        <Select value={kind} onValueChange={(next) => { if (next) setKind(next as "call_us" | "running_late"); }} items={messageItems} disabled={shared.pending}>
          <SelectTrigger aria-label="Message" size="lg"><SelectValue /></SelectTrigger>
          <SelectPopup>{messageItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
        </Select>
      </Field>
      {kind === "running_late" ? (
        <Field>
          <FieldLabel>How late</FieldLabel>
          <Select value={minutes} onValueChange={(next) => { if (next) setMinutes(String(next)); }} items={delayItems} disabled={shared.pending}>
            <SelectTrigger aria-label="Minutes late" size="lg"><SelectValue /></SelectTrigger>
            <SelectPopup>{delayItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
        </Field>
      ) : null}
    </ActionDialog>
  );
}

/** What a bulk run did: how many worked, and each one that did not, by name and time, with its reason. */
export function BulkResultDialog({ verb, result, rows, onClose }: { verb: string; result: BulkResult; rows: Map<string, BookingRow>; onClose: () => void }) {
  const failures = result.results.filter((item) => !item.ok);
  const headline = result.failed === 0 ? `${result.succeeded} ${verb}` : `${result.succeeded} ${verb}, ${result.failed} could not`;
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{headline}</DialogTitle>
          <DialogDescription>{failures.length > 0 ? "The ones that could not stay selected, so you can fix the cause and try again. Everything else went through." : "All done."}</DialogDescription>
        </DialogHeader>
        {failures.length > 0 ? (
          <DialogPanel>
            <ul aria-label="Bookings that could not be changed" className="flex flex-col divide-y rounded-lg border">
              {failures.map((item) => {
                const row = rows.get(item.id);
                return <li key={item.id} className="px-3 py-2 text-sm">{row ? <><span className="font-medium">{row.customer.name}</span> at <span className="tabular-nums">{appointmentDateTime(row.startsAt)}</span>: </> : null}{item.message ?? "It could not be changed."}</li>;
              })}
            </ul>
          </DialogPanel>
        ) : null}
        <DialogFooter><DialogClose render={<Button />}>{failures.length > 0 ? "Review them" : "Done"}</DialogClose></DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A plain "are you sure" for an action with no choices of its own. */
export function ConfirmDialog({ title, description, confirmLabel, destructive, onSubmit, ...shared }: ActionDialogShared & { title: string; description: ReactNode; confirmLabel: string; destructive?: boolean; onSubmit: () => void }) {
  return <ActionDialog {...shared} title={title} description={description} confirmLabel={confirmLabel} destructive={destructive} onSubmit={onSubmit}><span className="sr-only">Confirm to go ahead.</span></ActionDialog>;
}
