"use client";

import { useRef, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

import { SelectField, TextareaField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { broadcastSchema, walkInSchema, type SessionDetail } from "@/lib/classes-contracts";

import { addWalkIn, cancelSession, changeSeats, messageSession } from "./class-model";
import { StaffApiError } from "./queries/http";

function fail(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function Problem({ children }: { children: ReactNode }) {
  return <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>{children}</AlertDescription></Alert>;
}

/** A small form on a coss Dialog: a title, a body, and a submit button that shows it is working. */
function FormDialog({ title, description, submitLabel, pending, canSubmit = true, onSubmit, onClose, children }: {
  title: string; description: string; submitLabel: string; pending: boolean; canSubmit?: boolean; onSubmit: () => void; onClose: () => void; children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogPopup showCloseButton={!pending}>
        <form onSubmit={(event) => { event.preventDefault(); if (!pending && canSubmit) onSubmit(); }} className="contents" noValidate>
          <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
          <DialogPanel className="flex flex-col gap-4">{children}</DialogPanel>
          <DialogFooter>
            <DialogClose disabled={pending} render={<Button type="button" variant="ghost" />}>Not now</DialogClose>
            <Button type="submit" loading={pending} disabled={!canSubmit}>{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** A person who turned up without booking: a name and a phone or email is enough. */
export function WalkInDialog({ session, onClose, onDone }: { session: SessionDetail; onClose: () => void; onDone: (next: SessionDetail) => void }) {
  const t = useTerms();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const parsed = walkInSchema.safeParse({ firstName, lastName, ...(phone.trim() ? { phone } : {}), ...(email.trim() ? { email: email.trim() } : {}) });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message === "Choose a customer or give a name." ? "Give a first and last name." : "Check the name, phone number and email."); return; }
    setPending(true);
    setError("");
    try {
      const body = parsed.data;
      onDone(await addWalkIn(session.id, { ...(body.firstName ? { firstName: body.firstName } : {}), ...(body.lastName ? { lastName: body.lastName } : {}), ...(body.phone ? { phone: body.phone } : {}), ...(body.email ? { email: body.email } : {}) }));
      toastManager.add({ title: "Walk-in added", type: "success" });
      onClose();
    } catch (cause: unknown) {
      setError(cause instanceof StaffApiError && cause.code === "class_full" ? "This session is full. Add seats first, then add the person." : fail(cause, "The walk-in could not be added."));
    } finally {
      setPending(false);
    }
  }

  return (
    <FormDialog title="Add a walk-in" description={`Take a seat for a ${t.customer} who is here now. A phone number or email lets us message them later.`} submitLabel="Add walk-in" pending={pending} onSubmit={() => void submit()} onClose={onClose}>
      {error ? <Problem>{error}</Problem> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="First name" autoComplete="off" value={firstName} onChange={(event) => setFirstName(event.target.value)} />
        <TextField label="Last name" autoComplete="off" value={lastName} onChange={(event) => setLastName(event.target.value)} />
      </div>
      <TextField label="Phone" optional type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={(event) => setPhone(event.target.value)} />
      <TextField label="Email" optional type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
    </FormDialog>
  );
}

const audienceOptions = [
  { value: "booked", label: "People with a seat" },
  { value: "booked_and_waiting", label: "People with a seat and the waiting list" },
];

/** A short message to everyone in the class. One Idempotency-Key per submit, kept for a retry of the same one. */
export function MessageDialog({ session, onClose }: { session: SessionDetail; onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [audience, setAudience] = useState<"booked" | "booked_and_waiting">("booked");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const key = useRef<string | null>(null);
  const seated = session.roster.filter((entry) => entry.status !== "waitlisted").length;
  const waiting = session.roster.length - seated;
  const count = audience === "booked" ? seated : seated + waiting;

  async function submit() {
    const parsed = broadcastSchema.safeParse({ message, audience });
    if (!parsed.success) { setError("Write a message of up to 500 characters."); return; }
    key.current ??= crypto.randomUUID();
    setPending(true);
    setError("");
    try {
      const result = await messageSession(session.id, parsed.data, key.current);
      key.current = null;
      toastManager.add({ title: `Message sent to ${result.queued} ${result.queued === 1 ? "person" : "people"}`, type: "success" });
      onClose();
    } catch (cause: unknown) {
      setError(fail(cause, "The message could not be sent. You can try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <FormDialog title="Message everyone" description="Everyone chosen gets this by their usual channel." submitLabel={`Send to ${count}`} pending={pending} canSubmit={message.trim().length > 0 && count > 0} onSubmit={() => void submit()} onClose={onClose}>
      {error ? <Problem>{error}</Problem> : null}
      <SelectField label="Who gets it" value={audience} onValueChange={(next) => { key.current = null; setAudience(next === "booked_and_waiting" ? "booked_and_waiting" : "booked"); }} options={audienceOptions} />
      <TextareaField label="Message" value={message} maxLength={500} onChange={(event) => { key.current = null; setMessage(event.target.value); }} hint={`${message.length} of 500. ${count} ${count === 1 ? "person" : "people"} will be messaged.`} />
    </FormDialog>
  );
}

/** Seats for this one session. The change is checked against the version the screen loaded. */
export function SeatsDialog({ session, onClose, onDone, onConflict }: { session: SessionDetail; onClose: () => void; onDone: (next: SessionDetail) => void; onConflict: () => void }) {
  const [value, setValue] = useState(String(session.capacity));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const seats = Number(value);
  const valid = Number.isInteger(seats) && seats >= 1 && seats <= 500;

  async function submit() {
    setPending(true);
    setError("");
    try {
      onDone(await changeSeats(session.id, { expectedVersion: session.version, capacity: seats }));
      toastManager.add({ title: "Seats changed", type: "success" });
      onClose();
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError && cause.code === "version_conflict") { onConflict(); setError("Someone else just changed this session. It has been refreshed. Try again."); }
      else setError(fail(cause, "The seats could not be changed."));
    } finally {
      setPending(false);
    }
  }

  return (
    <FormDialog title="Change seats" description={`${session.seatsTaken} seats are taken now. Only this session changes.`} submitLabel="Save seats" pending={pending} canSubmit={valid && seats !== session.capacity} onSubmit={() => void submit()} onClose={onClose}>
      {error ? <Problem>{error}</Problem> : null}
      <TextField label="Seats" type="number" inputMode="numeric" min={1} max={500} value={value} onChange={(event) => setValue(event.target.value)} error={value !== "" && !valid ? "Choose between 1 and 500." : undefined} />
    </FormDialog>
  );
}

/** Cancelling a session. Says plainly that everyone is told. */
export function CancelSessionDialog({ session, onClose, onDone, onConflict }: { session: SessionDetail; onClose: () => void; onDone: () => void; onConflict: () => void }) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const people = session.roster.length;

  async function submit() {
    setPending(true);
    setError("");
    try {
      const result = await cancelSession(session.id, { expectedVersion: session.version, ...(note.trim() ? { note: note.trim() } : {}) });
      toastManager.add({ title: "Session cancelled", description: `${result.notified} ${result.notified === 1 ? "person was" : "people were"} told.`, type: "success" });
      onDone();
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError && cause.code === "version_conflict") { onConflict(); setError("Someone else just changed this session. It has been refreshed. Check it and try again."); }
      else setError(fail(cause, "The session could not be cancelled."));
      setPending(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this session?</AlertDialogTitle>
          <AlertDialogDescription>{people === 0 ? "Nobody has a seat, so nobody needs telling." : `Everyone is told: ${people} ${people === 1 ? "person" : "people"}, including the waiting list. This cannot be undone.`}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-4 px-6 pb-2">
          {error ? <Problem>{error}</Problem> : null}
          <TextareaField label="A line for them to read" optional value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} hint="For example: the teacher is unwell." />
        </div>
        <AlertDialogFooter>
          <AlertDialogClose disabled={pending} render={<Button variant="ghost" />}>Keep session</AlertDialogClose>
          <Button variant="destructive" loading={pending} onClick={() => void submit()}>Cancel session</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
