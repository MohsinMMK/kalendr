"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ArrowRight, CalendarClock, CircleCheck, Clock3, FileWarning, Hourglass, Plus } from "lucide-react";
import Link from "next/link";

import { OptionSelect, TextareaField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Form } from "@/components/ui/form";
import { Frame, FramePanel } from "@/components/ui/frame";
import { Meter, MeterIndicator, MeterTrack } from "@/components/ui/meter";
import { Drawer, DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { DeclineReason } from "@/lib/approval";
import type { Appointment, Patient, Practitioner } from "@/lib/domain";
import { HEARD_FROM_WINDOW_DAYS, summarizeHeardFrom } from "@/lib/heard-from";
import { cn } from "@/lib/utils";

import { appointmentTime } from "./clinic-format";
import { DeclineDialog } from "./decline-dialog";
import { useStaffAccess } from "./staff-access";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { appointmentPatientName, type ActionItem, type ActionKind } from "./clinic-today";
import { clinicDateKey } from "./preview-appointments";
import type { ShiftNote, useHandoverNotes } from "./use-handover-notes";

type PanelProps = { open: boolean; onOpenChange: (open: boolean) => void };

// ── Overview ─────────────────────────────────────────────────────────────

export type Tile = { id: string; label: string; value: number; hint?: string; attention?: boolean; progress?: { value: number; max: number } };

const tileGrid: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2 divide-x",
  3: "grid-cols-3 divide-x",
  4: "grid-cols-2 sm:grid-cols-4 sm:divide-x [&>div:nth-child(-n+2)]:border-b sm:[&>div:nth-child(-n+2)]:border-b-0 [&>div:nth-child(2)]:border-s sm:[&>div:nth-child(2)]:border-s-0",
};

export function Overview({ items, progressLabel }: { progressLabel: string; items: Tile[] }) {
  return (
    <Card className="lg:shrink-0">
      {/* The numbers arrive one after another; while the page is arriving the dashboard sets --tiles-offset so they follow the card. */}
      <dl
        className={cn(
          "grid divide-border",
          "*:motion-safe:fade-in-0 *:motion-safe:slide-in-from-bottom-1 *:motion-safe:animate-in *:motion-safe:fill-mode-backwards *:motion-safe:duration-500 *:motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
          "*:motion-safe:[--tw-animation-delay:var(--tiles-offset,0ms)] [&>*:nth-child(2)]:motion-safe:[--tw-animation-delay:calc(var(--tiles-offset,0ms)_+_60ms)] [&>*:nth-child(3)]:motion-safe:[--tw-animation-delay:calc(var(--tiles-offset,0ms)_+_120ms)] [&>*:nth-child(4)]:motion-safe:[--tw-animation-delay:calc(var(--tiles-offset,0ms)_+_180ms)]",
          tileGrid[items.length],
        )}
      >
        {items.map((item) => (
          <div key={item.id} className="flex min-w-0 flex-col gap-0.5 px-4 py-3">
            <dt className="truncate text-xs text-muted-foreground">{item.label}</dt>
            <dd className={cn("font-heading text-2xl font-semibold tabular-nums", item.attention && "text-warning-foreground")}>{item.value}</dd>
            {item.hint ? <dd className="truncate text-xs text-muted-foreground">{item.hint}</dd> : null}
            {item.progress ? (
              <dd className="pt-1">
                <Meter value={item.progress.value} max={Math.max(item.progress.max, 1)} aria-label={progressLabel}>
                  <MeterTrack className="h-1"><MeterIndicator /></MeterTrack>
                </Meter>
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
    </Card>
  );
}

// ── Side panels ──────────────────────────────────────────────────────────

/** A right-hand panel opened from a header button or its ⋯ menu entry. */
function SidePanel({ open, onOpenChange, title, description, children, footer }: PanelProps & {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} position="right">
      <DrawerPopup variant="inset" showCloseButton aria-label={title}>
        <DrawerHeader className="pe-14">
          <DrawerTitle>{title}</DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel>{children}</DrawerPanel>
        {footer ? <DrawerFooter>{footer}</DrawerFooter> : null}
      </DrawerPopup>
    </Drawer>
  );
}

const actionIcon: Record<ActionKind, typeof Clock3> = { wait: Hourglass, request: CalendarClock, form: FileWarning };

/**
 * Requests, missing forms and long waits, as one list. The header bell's Needs attention tab shows it. In the preview each
 * one can be given an owner; with a database, a request can be approved or declined right here by anyone who may approve.
 */
export function AttentionList({ items, patients, practitioners, owners, onAssign }: {
  items: ActionItem[];
  patients: Patient[];
  practitioners: Practitioner[];
  /** Preview only: who owns each item. Leave out with a database. */
  owners?: Record<string, string>;
  onAssign?: (key: string, owner: string) => void;
}) {
  const t = useTerms();
  const staff = useOptionalStaffSnapshot();
  const canApprove = useStaffAccess().can("appointments.book") && Boolean(staff);
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<ActionItem | null>(null);
  const [error, setError] = useState("");
  const [declineError, setDeclineError] = useState("");

  async function send(item: ActionItem, body: Record<string, unknown>): Promise<boolean> {
    const version = staff?.snapshot?.appointments.find((appointment) => appointment.id === item.appointment.id)?.version;
    if (!version) {
      const message = `This ${t.appointment} changed since you opened it. Refresh and try again.`;
      if (body.action === "decline") setDeclineError(message); else setError(message);
      return false;
    }
    setBusy(item.key);
    try {
      await staffMutation(`/api/staff/appointments/${encodeURIComponent(item.appointment.id)}`, "PATCH", { ...body, expectedVersion: version });
      await staff?.refresh();
      return true;
    } catch (cause: unknown) {
      const message = cause instanceof Error && cause.message ? cause.message : `Could not save this ${t.appointment}. Try again.`;
      if (body.action === "decline") setDeclineError(message); else setError(message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function approve(item: ActionItem) {
    setError("");
    if (await send(item, { action: "approve" })) toastManager.add({ title: "Request approved", description: `The ${t.customer} will be told.`, type: "success" });
  }

  async function decline(item: ActionItem, input: { reason: DeclineReason; message: string }) {
    setDeclineError("");
    if (await send(item, { action: "decline", reason: input.reason, ...(input.message ? { message: input.message } : {}) })) {
      setDeclining(null);
      toastManager.add({ title: "Request declined", description: `The ${t.customer} will be told.`, type: "success" });
    }
  }

  if (!items.length) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><CircleCheck aria-hidden="true" /></EmptyMedia>
          <EmptyDescription>All clear. Nothing needs a decision right now.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      {error ? <p role="alert" className="mb-2 text-sm text-destructive-foreground">{error}</p> : null}
      <Frame role="region" aria-label="Needs attention">
        {items.map((item) => {
          const Icon = actionIcon[item.kind];
          const inline = canApprove && item.kind === "request" && item.appointment.status === "requested";
          return (
            <FramePanel key={item.key} className="flex flex-col gap-3 p-3">
              <div className="flex items-start gap-2.5">
                <Icon className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium">{item.title}</h3>
                  <p className="truncate text-xs text-muted-foreground">{item.detail}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 ps-6.5">
                {owners && onAssign ? (
                  <OptionSelect
                    aria-label={`Owner for ${item.title.toLowerCase()} for ${appointmentPatientName(item.appointment, patients, t)}`}
                    size="sm"
                    className="w-auto max-w-40 min-w-28"
                    value={owners[item.key] ?? "Unassigned"}
                    onValueChange={(owner) => onAssign(item.key, owner)}
                    options={[{ value: "Unassigned", label: "Unassigned" }, { value: "Reception", label: "Reception" }, ...practitioners.map((person) => ({ value: person.name, label: person.name }))]}
                  />
                ) : <span />}
                <div className="flex items-center gap-2">
                  {inline ? (
                    <>
                      <Button size="xs" variant="destructive-outline" aria-label={`Decline request: ${item.detail}`} disabled={busy !== null} onClick={() => { setDeclineError(""); setDeclining(item); }}>Decline</Button>
                      <Button size="xs" aria-label={`Approve request: ${item.detail}`} loading={busy === item.key} disabled={busy !== null && busy !== item.key} onClick={() => void approve(item)}>Approve</Button>
                    </>
                  ) : null}
                  <Button size="xs" variant="outline" render={<Link href={item.href} />}>{inline ? "Open" : item.linkLabel} <ArrowRight aria-hidden="true" /></Button>
                </div>
              </div>
            </FramePanel>
          );
        })}
      </Frame>
      {declining ? <DeclineDialog open onOpenChange={(next) => { if (!next) setDeclining(null); }} pending={busy === declining.key} error={declineError} onSubmit={(input) => void decline(declining, input)} /> : null}
    </>
  );
}

/** "How people found you": the answers customers gave on their confirmation, last 90 days. */
export function HeardFromPanel({ appointments, nowIso, ...panel }: PanelProps & { appointments: Appointment[]; nowIso: string }) {
  const t = useTerms();
  const summary = useMemo(() => summarizeHeardFrom(appointments, new Date(nowIso)), [appointments, nowIso]);
  return (
    <SidePanel {...panel} title="How people found you" description={`What ${t.customers} answered after booking, last ${HEARD_FROM_WINDOW_DAYS} days.`}>
      {!summary.total ? (
        <p className="text-sm text-muted-foreground">No answers yet. After booking, {t.customers} are asked how they heard about you, and their answers show up here.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{summary.total} {summary.total === 1 ? "answer" : "answers"} in the last {HEARD_FROM_WINDOW_DAYS} days.</p>
          <ul aria-label="How people found you" className="flex flex-col gap-3">
            {summary.rows.map((row) => (
              <li key={row.value} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate">{row.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{row.count} · {Math.round(row.share * 100)}%</span>
                </div>
                <Meter value={row.count} max={summary.total} aria-label={`${row.label}: ${row.count} of ${summary.total}`}>
                  <MeterTrack className="h-1.5"><MeterIndicator /></MeterTrack>
                </Meter>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SidePanel>
  );
}

/** "9:15 pm" for today's notes, "Yesterday 6:40 pm" for older ones. */
function noteWhen(at: string, nowIso: string): string {
  const time = appointmentTime(at);
  const days = Math.round((Date.parse(clinicDateKey(nowIso)) - Date.parse(clinicDateKey(at))) / 86_400_000);
  return days <= 0 ? time : days === 1 ? `Yesterday ${time}` : `${days} days ago ${time}`;
}

/** Notes for the next shift: the list, removing with Undo, and the add-note dialog. */
export function HandoverPanel({ handover, clockIso, shared, clinical, ...panel }: PanelProps & {
  handover: ReturnType<typeof useHandoverNotes>;
  clockIso: string;
  /** With a database the whole team sees the notes. */
  shared: boolean;
  clinical: boolean;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // A toast's Undo runs after later renders, so it has to reach the current save function.
  const addNote = useRef(handover.add);
  useEffect(() => { addNote.current = handover.add; });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    try {
      await handover.add(text);
      setDraft("");
      setNoteOpen(false);
      toastManager.add({ title: "Handover note saved", description: shared ? "Everyone on your team can see it on Today." : undefined, type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Note not saved", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function remove(note: ShiftNote) {
    try {
      await handover.remove(note);
    } catch (cause: unknown) {
      toastManager.add({ title: "Note not removed", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
      return;
    }
    const id = toastManager.add({
      title: "Handover note removed",
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(id);
          addNote.current(note.text).catch(() => toastManager.add({ title: "Could not restore the handover note", type: "error" }));
        },
      },
    });
  }

  return (
    <>
      <SidePanel
        {...panel}
        title="Handover"
        description="Scheduling context for the next shift."
        footer={<Button onClick={() => { panel.onOpenChange(false); setNoteOpen(true); }}><Plus aria-hidden="true" />Add note</Button>}
      >
        {handover.loadError ? (
          <p className="text-sm text-destructive-foreground">{handover.loadError}</p>
        ) : handover.loading ? (
          <p className="text-sm text-muted-foreground">Loading notes…</p>
        ) : handover.notes.length ? (
          <ul aria-label="Handover notes" className="flex flex-col gap-3">
            {handover.notes.map((note) => (
              <li key={note.id} className="text-sm">
                <p className="break-words whitespace-pre-wrap">{note.text}</p>
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{note.author} · {noteWhen(note.at, clockIso)}</span>
                  {note.canRemove ? <Button size="xs" variant="ghost" onClick={() => void remove(note)}>Remove</Button> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">No handover notes from the last two days.</p>}
      </SidePanel>

      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Add handover note</DialogTitle>
            <DialogDescription>{clinical ? "For scheduling context only. Do not enter clinical information." : "For scheduling context only."}</DialogDescription>
          </DialogHeader>
          <Form className="contents" onSubmit={submit}>
            <DialogPanel>
              <TextareaField label="Scheduling note" value={draft} onChange={(event) => setDraft(event.target.value)} required maxLength={280} rows={3} placeholder="Share a scheduling handover…" />
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
              <Button type="submit" loading={saving}>Save note</Button>
            </DialogFooter>
          </Form>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** Asks why a waiting customer is urgent before they jump the queue. */
export function UrgentDialog({ number, clinical, onCancel, onConfirm }: {
  /** The token being marked. Null keeps the dialog closed. */
  number: number | null;
  clinical: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = reason.trim();
    if (!text) return;
    setReason("");
    onConfirm(text);
  }
  return (
    <Dialog open={number !== null} onOpenChange={(next) => { if (!next) { setReason(""); onCancel(); } }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Mark #{number} urgent</DialogTitle>
          <DialogDescription>They will be called before everyone else. Your team sees who marked it and why.</DialogDescription>
        </DialogHeader>
        <Form className="contents" onSubmit={submit}>
          <DialogPanel>
            <TextareaField label="Reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={200} rows={2} placeholder={clinical ? "For example: severe pain" : "For example: has to leave soon"} />
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit">Mark urgent</Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}
