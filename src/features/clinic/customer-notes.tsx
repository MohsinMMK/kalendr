"use client";

import { Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useState } from "react";

import { TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { isClinicalBusinessType } from "@/lib/business-types";
import type { CustomerNote } from "@/lib/customer-contracts";

import { useCustomerChanged } from "./customer-dialogs";
import { dateTimeLabel, errorText, ListSkeleton, LoadFailed } from "./customer-parts";
import { useCustomerNotes } from "./queries/customers";
import { staffMutation } from "./queries/http";
import { useStaffAccess } from "./staff-access";

function NoteCard({ patientId, note, canWrite, canEditWords }: { patientId: string; note: CustomerNote; canWrite: boolean; canEditWords: boolean }) {
  const changed = useCustomerChanged();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.body);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const base = `/api/staff/customers/${encodeURIComponent(patientId)}/notes/${encodeURIComponent(note.id)}`;

  async function patch(body: { body?: string; pinned?: boolean }) {
    setBusy(true); setMessage("");
    try {
      await staffMutation(base, "PATCH", { ...body, version: note.version });
      changed();
      setEditing(false);
    } catch (cause: unknown) {
      setMessage(errorText(cause, "The note could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await staffMutation(base, "DELETE", {});
      changed();
      toastManager.add({ title: "Note deleted", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not delete the note", description: errorText(cause, "Try again."), type: "error" });
    }
  }

  return (
    <li className="rounded-lg border p-3" aria-label={note.pinned ? "Pinned note" : "Note"}>
      {editing ? (
        <form className="flex flex-col gap-2" aria-label="Change note" onSubmit={(event) => { event.preventDefault(); void patch({ body: text.trim() }); }}>
          <TextareaField label="Note" value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} rows={4} />
          {message ? <p role="alert" className="text-destructive-foreground text-sm">{message}</p> : null}
          <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy || !text.trim()}>Save</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setText(note.body); }}>Cancel</Button></div>
        </form>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm">{note.body}</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">{note.authorName}, <time dateTime={note.createdAt}>{dateTimeLabel(note.createdAt)}</time>{note.pinned ? " · Pinned" : ""}</p>
            {canWrite ? (
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void patch({ pinned: !note.pinned })}>{note.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}{note.pinned ? "Unpin" : "Pin"}</Button>
                {canEditWords ? <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil aria-hidden="true" />Edit</Button> : null}
                {canEditWords ? <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}><Trash2 aria-hidden="true" />Delete</Button> : null}
              </div>
            ) : null}
          </div>
          {message ? <p role="alert" className="mt-1 text-destructive-foreground text-sm">{message}</p> : null}
        </>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader><AlertDialogTitle>Delete this note?</AlertDialogTitle><AlertDialogDescription>This cannot be undone.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep it</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" onClick={() => void remove()} />}>Delete note</AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}

/** Internal notes: attributed and dated. Not clinical records; a healthcare business is told so right at the box. */
export function CustomerNotes({ patientId }: { patientId: string }) {
  const t = useTerms();
  const profile = useBusinessProfile();
  const access = useStaffAccess();
  const changed = useCustomerChanged();
  const query = useCustomerNotes(patientId);
  const canWrite = access.can("customers.manage");
  const [text, setText] = useState("");
  const [pinned, setPinned] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const clinical = isClinicalBusinessType(profile.businessType);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setMessage("");
    try {
      await staffMutation(`/api/staff/customers/${encodeURIComponent(patientId)}/notes`, "POST", { body: text.trim(), pinned }, { idempotencyKey: key });
      setKey(crypto.randomUUID());
      setText(""); setPinned(false);
      changed();
    } catch (cause: unknown) {
      setKey(crypto.randomUUID());
      setMessage(errorText(cause, "The note could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {canWrite ? (
        <form className="flex flex-col gap-2" aria-label="Add a note" onSubmit={(event) => void add(event)}>
          <TextareaField label="Add a note" hint={clinical ? `For the team only: preferences, reminders, things to remember. These are not clinical records. Write those in ${t.Customer} records.` : "For the team only: preferences, reminders, things to remember about this " + t.customer + "."} value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} rows={3} />
          {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label className="min-h-11 font-normal sm:min-h-8"><Checkbox checked={pinned} onCheckedChange={(next) => setPinned(next === true)} />Pin to the top of the profile</Label>
            <Button type="submit" disabled={busy || !text.trim()}>{busy ? <Spinner /> : null}Add note</Button>
          </div>
        </form>
      ) : null}
      {query.isPending ? <ListSkeleton label="Loading notes" rows={2} /> : null}
      {query.isError ? <LoadFailed message={query.error instanceof Error ? query.error.message : "The notes could not be loaded."} onRetry={() => void query.refetch()} /> : null}
      {query.isSuccess && query.data.length === 0 ? (
        <Empty className="p-4 md:p-6"><EmptyHeader><EmptyMedia variant="icon"><Pencil aria-hidden="true" /></EmptyMedia><EmptyTitle className="text-base">No notes yet</EmptyTitle><EmptyDescription>Notes you add are dated and carry your name.</EmptyDescription></EmptyHeader></Empty>
      ) : null}
      {query.isSuccess && query.data.length > 0 ? (
        <ul aria-label="Notes" className="flex flex-col gap-2">
          {query.data.map((note) => <NoteCard key={note.id} patientId={patientId} note={note} canWrite={canWrite} canEditWords={canWrite && (note.authorUserId === access.userId || access.can("settings.manage"))} />)}
        </ul>
      ) : null}
    </div>
  );
}
