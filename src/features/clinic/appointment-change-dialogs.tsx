"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { DatePicker } from "@/components/date-picker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmailList } from "@/features/booking/email-list";
import { useTerms } from "@/features/terms/business-profile-context";
import { MAX_NOTE_LENGTH } from "@/lib/cancel-policy";
import type { Appointment, TimeSlot } from "@/lib/domain";

import { appointmentTime } from "./clinic-format";
import { clinicDayBounds, useCatalogLookups } from "./clinic-catalog";
import { clinicDateKey } from "./schedule-availability";
import { fetchAvailabilitySlots, staffQuery } from "./staff-snapshot-provider";

export interface DialogShared {
  pending: boolean;
  error: string;
  onClose: () => void;
}

/** The shell every change dialog shares: title, one sentence, the form, and a footer that never wraps. */
function ChangeDialog({ title, description, pending, error, onClose, confirmLabel, destructive, canSubmit = true, onSubmit, children }: DialogShared & {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  canSubmit?: boolean;
  onSubmit: () => void;
  children: ReactNode;
}) {
  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSubmit && !pending) onSubmit();
  }
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogPopup showCloseButton={!pending}>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
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

function NoteField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (next: string) => void; disabled: boolean }) {
  return <Field>
    <FieldLabel>{label}</FieldLabel>
    <Textarea aria-label={label} value={value} maxLength={MAX_NOTE_LENGTH} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    <p className="self-end text-xs text-muted-foreground tabular-nums" aria-live="polite">{value.length} / {MAX_NOTE_LENGTH}</p>
  </Field>;
}

/** Freeing the time and asking the customer to pick a new one. */
export function RequestRescheduleDialog({ onSubmit, ...shared }: DialogShared & { onSubmit: (input: { message: string }) => void }) {
  const t = useTerms();
  const [message, setMessage] = useState("");
  return <ChangeDialog {...shared} title="Ask to choose a new time" confirmLabel="Ask them" onSubmit={() => onSubmit({ message: message.trim() })}
    description={`This frees the time now. The ${t.customer} gets a message with a link to choose a new one.`}>
    <NoteField label={`Message to the ${t.customer} (they will see it)`} value={message} onChange={setMessage} disabled={shared.pending} />
  </ChangeDialog>;
}

interface Preset { id: string; label: string; sortOrder: number }
const NO_REASON = "none";

/** Cancelling with one of the business's reasons, a private note, and a choice about telling the customer. */
export function CancelWithReasonDialog({ onSubmit, ...shared }: DialogShared & { onSubmit: (input: { presetId?: string; note: string; notifyCustomer: boolean }) => void }) {
  const t = useTerms();
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [presetId, setPresetId] = useState<string>(NO_REASON);
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    staffQuery<Preset[]>("/api/staff/cancel-presets", controller.signal)
      .then((rows) => { if (!controller.signal.aborted) setPresets(rows); })
      .catch(() => { if (!controller.signal.aborted) { setPresets([]); setLoadFailed(true); } });
    return () => controller.abort();
  }, []);

  const items = useMemo(() => [{ value: NO_REASON, label: "No specific reason" }, ...(presets ?? []).map((preset) => ({ value: preset.id, label: preset.label }))], [presets]);
  return <ChangeDialog {...shared} title={`Cancel this ${t.appointment}`} confirmLabel={`Cancel ${t.appointment}`} destructive
    onSubmit={() => onSubmit({ ...(presetId !== NO_REASON ? { presetId } : {}), note: note.trim(), notifyCustomer: notify })}
    description={`This frees the time. Choose a reason to keep on record${notify ? ` and to tell the ${t.customer}` : ""}.`}>
    <Field>
      <FieldLabel>Reason</FieldLabel>
      <Select value={presetId} onValueChange={(next) => { if (next) setPresetId(String(next)); }} items={items} disabled={shared.pending || presets === null}>
        <SelectTrigger aria-label="Reason" size="lg"><SelectValue placeholder={presets === null ? "Loading reasons…" : "No specific reason"} /></SelectTrigger>
        <SelectPopup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
      </Select>
      {loadFailed ? <p role="status" className="text-xs text-muted-foreground">Your reasons could not be loaded. You can still cancel without one.</p> : null}
    </Field>
    <NoteField label="Note for your team (only staff see it)" value={note} onChange={setNote} disabled={shared.pending} />
    <Label className="min-h-11 sm:min-h-0"><Checkbox checked={notify} onCheckedChange={(next) => setNotify(next === true)} disabled={shared.pending} />Tell the {t.customer}</Label>
  </ChangeDialog>;
}

/** Booking the same visit again at a new time: pick a day, then one of its openings. */
export function BookAgainDialog({ appointment, onSubmit, ...shared }: DialogShared & { appointment: Appointment; onSubmit: (input: { startsAt: string; practitionerId: string }) => Promise<string | null> }) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const router = useRouter();
  const [date, setDate] = useState(() => clinicDateKey(new Date().toISOString()));
  const [loaded, setLoaded] = useState<{ date: string; slots: TimeSlot[]; failed: boolean } | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  const current = loaded && loaded.date === date ? loaded : null;
  const loading = current === null;
  const slots = current?.slots ?? [];
  const chosen = slots.find((slot) => slot.id === slotId);

  useEffect(() => {
    const controller = new AbortController();
    const bounds = clinicDayBounds(date);
    fetchAvailabilitySlots({ clinicSlug: catalog.clinic.slug, locationId: appointment.locationId, serviceId: appointment.serviceId, from: bounds.from, to: bounds.to }, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setLoaded({ date, slots: next, failed: false }); })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ date, slots: [], failed: true }); });
    return () => controller.abort();
  }, [appointment.locationId, appointment.serviceId, catalog.clinic.slug, date]);

  const items = slots.map((slot) => ({ value: slot.id, label: `${appointmentTime(slot.startsAt)} · ${catalog.practitionerName(slot.practitionerId)}` }));
  async function submit() {
    if (!chosen) return;
    const created = await onSubmit({ startsAt: chosen.startsAt, practitionerId: chosen.practitionerId });
    if (created) router.push(`/appointments/${encodeURIComponent(created)}`);
  }
  return <ChangeDialog {...shared} title={`Book this ${t.appointment} again`} confirmLabel="Book again" canSubmit={Boolean(chosen)} onSubmit={() => void submit()}
    description={`This makes a new ${t.appointment} for the same ${t.customer} and service. The old one stays as it is.`}>
    <Field>
      <FieldLabel>Day</FieldLabel>
      <DatePicker aria-label="Day" value={date} min={clinicDateKey(new Date().toISOString())} disabled={shared.pending} onValueChange={(next) => { setDate(next); setSlotId(null); }} />
    </Field>
    <Field>
      <FieldLabel>Time</FieldLabel>
      <Select value={slotId} onValueChange={(next) => { if (next) setSlotId(String(next)); }} items={items} disabled={shared.pending || loading || slots.length === 0}>
        <SelectTrigger aria-label="Time" size="lg"><SelectValue placeholder={loading ? "Loading openings…" : slots.length ? "Choose a time" : "No openings this day"} /></SelectTrigger>
        <SelectPopup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
      </Select>
      {current?.failed ? <p role="status" className="text-xs text-destructive-foreground">Openings could not be loaded. Try another day.</p> : null}
    </Field>
  </ChangeDialog>;
}

/** Replacing the guest list. Guest emails are sealed, so the list starts empty. */
export function EditGuestsDialog({ maxGuests, onSubmit, ...shared }: DialogShared & { maxGuests: number; onSubmit: (input: { guests: string[] }) => void }) {
  const [guests, setGuests] = useState<string[]>([]);
  const valid = guests.every((email) => /^\S+@\S+\.\S+$/.test(email));
  return <ChangeDialog {...shared} title="Edit guests" confirmLabel="Save guests" canSubmit={valid} onSubmit={() => onSubmit({ guests })}
    description="This replaces the guest list. Add everyone who should be on it; leave it empty to remove all guests.">
    <EmailList id="edit-guests" value={guests} onChange={setGuests} max={maxGuests} rowLabel="Guest email" addLabel="Add another guest" disabled={shared.pending} invalid={!valid} />
    {!valid ? <p className="text-xs text-destructive-foreground">Check the email addresses.</p> : null}
  </ChangeDialog>;
}
