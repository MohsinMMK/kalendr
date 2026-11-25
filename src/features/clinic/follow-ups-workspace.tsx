"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BellRing, CalendarOff, CalendarX, CheckCheck, ChevronRight, CircleCheck, Clock, Ellipsis, Hourglass, ListChecks, Pencil, RotateCcw, Send, ThumbsDown, TriangleAlert } from "lucide-react";

import { ActionMenuButton, type ActionMenuEntry } from "@/components/action-bar";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PersonAvatar } from "@/components/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Card, CardFooter, CardHeader, CardPanel } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { useFeatures, useTerms } from "@/features/terms/business-profile-context";
import { demoQueues, demoWaitlist, getPatient } from "@/lib/demo-data";
import type { Recall, TimeSlot, WaitlistEntry } from "@/lib/domain";

import { appointmentDateTime, channelLabel } from "./clinic-format";
import { useCatalogLookups } from "./clinic-catalog";
import { compatibleSlots, usePreviewAppointments } from "./preview-appointments";
import { fetchAvailabilitySlots, staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { Fact, OpeningButton, TaskSteps } from "./task-ui";
import { useStaffAccess } from "./staff-access";
import { WaitlistOffersPanel } from "./waitlist-offers-panel";
import { ScrollArea } from "@/components/ui/scroll-area";

type Tab = "waitlist" | "offers" | "recalls";
type Step = "browse" | "choose" | "review" | "result";
type Task = { kind: "waitlist"; id: string } | { kind: "recall"; id: string };

const initialRecalls: Recall[] = [
  { id: "recall_varun", patientId: "patient_varun", serviceId: "service_implant", dueAt: "2026-08-28T09:00:00+05:30", status: "overdue" },
  { id: "recall_sneha", patientId: "patient_sneha", serviceId: "service_filling", dueAt: "2026-08-31T09:00:00+05:30", status: "due" },
  { id: "recall_ananya", patientId: "patient_ananya", serviceId: "service_cleaning", dueAt: "2026-09-15T09:00:00+05:30", status: "upcoming" },
];
const waitlistNames = new Map(demoQueues.filter((item) => item.kind === "waitlist").map((item) => [item.id.replace("queue_", "waitlist_"), item.patientName]));

const dayFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const dayKeyFormat = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Kolkata" });
/** The clinic-local calendar day (yyyy-mm-dd) of a date or timestamp. */
export function clinicDay(value: string) {
  return value.length <= 10 ? value : dayKeyFormat.format(new Date(value));
}
function shortDate(dateKey: string) {
  return dayFormat.format(new Date(`${clinicDay(dateKey)}T12:00:00+05:30`));
}

export type RecallPatch = { status?: Recall["status"]; dueAt?: string };
export type WaitlistPatch = Partial<Pick<WaitlistEntry, "status" | "dateFrom" | "dateTo" | "timePreference">>;
const timePreferences: { value: WaitlistEntry["timePreference"]; label: string }[] = [
  { value: "any", label: "Any time" }, { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" }, { value: "evening", label: "Evening" },
];
const waitlistLabels: Record<WaitlistEntry["status"], string> = { active: "Waiting", offered: "Offer prepared", fulfilled: "Fulfilled", expired: "Expired", declined: "Declined" };
const recallLabels: Record<Recall["status"], string> = { upcoming: "Upcoming", due: "Due", overdue: "Overdue", contacted: "Reminder prepared", snoozed: "Snoozed", booked: "Booked", closed: "Closed", };

/** Every sensible status move for a recall, other than the one it is already in. */
export function recallMoves(current: Recall["status"], save: (patch: RecallPatch) => void): ActionMenuEntry[] {
  const moves: { status: Recall["status"]; label: string; icon: React.ReactNode }[] = [
    { status: "contacted", label: "Mark contacted", icon: <Send /> },
    { status: "snoozed", label: "Snooze", icon: <Clock /> },
    { status: "booked", label: "Mark booked", icon: <CheckCheck /> },
    { status: "closed", label: "Close", icon: <CalendarX /> },
    { status: "due", label: "Reopen as due", icon: <RotateCcw /> },
  ];
  return moves.filter((move) => move.status !== current && !(move.status === "due" && (current === "overdue" || current === "upcoming")))
    .map((move) => ({ id: move.status, label: move.label, icon: move.icon, onSelect: () => save({ status: move.status }) }));
}

/** Every sensible status move for a waitlist entry, other than the one it is already in. */
export function waitlistMoves(current: WaitlistEntry["status"], save: (patch: WaitlistPatch) => void): ActionMenuEntry[] {
  const moves: { status: WaitlistEntry["status"]; label: string; icon: React.ReactNode }[] = [
    { status: "offered", label: "Mark offered", icon: <Send /> },
    { status: "fulfilled", label: "Mark fulfilled", icon: <CheckCheck /> },
    { status: "expired", label: "Expire", icon: <Hourglass /> },
    { status: "declined", label: "Decline", icon: <ThumbsDown /> },
    { status: "active", label: "Reactivate", icon: <RotateCcw /> },
  ];
  return moves.filter((move) => move.status !== current)
    .map((move) => ({ id: move.status, label: move.label, icon: move.icon, onSelect: () => save({ status: move.status }) }));
}

function EditTrigger({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <PopoverTrigger render={<Button size="sm" variant="ghost" className="-ms-2 tabular-nums" aria-label={label} />}>
      {children}<Pencil aria-hidden="true" className="opacity-60" />
    </PopoverTrigger>
  );
}

/** Edits a recall's due date in place. `onSave` resolves true when the change was stored. */
export function DueDateEditor({ value, onSave, name }: { value: string; onSave: (dateKey: string) => Promise<boolean>; name: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(clinicDay(value));
  const [busy, setBusy] = useState(false);
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setDraft(clinicDay(value)); }}>
      <EditTrigger label={`Change due date for ${name}, currently ${shortDate(value)}`}>{shortDate(value)}</EditTrigger>
      <PopoverPopup align="start" className="w-64">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            Due date
            <Input type="date" aria-label="Due date" className="tabular-nums" value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <Button size="sm" loading={busy} disabled={!draft || draft === clinicDay(value)} onClick={() => { setBusy(true); void onSave(draft).then((ok) => { setBusy(false); if (ok) setOpen(false); }); }}>Save due date</Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Edits a waitlist entry's wanted dates and time of day in place. */
export function WindowEditor({ entry, onSave, name }: { entry: WaitlistEntry; onSave: (patch: WaitlistPatch) => Promise<boolean>; name: string }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(entry.dateFrom);
  const [to, setTo] = useState(entry.dateTo);
  const [time, setTime] = useState(entry.timePreference);
  const [busy, setBusy] = useState(false);
  const invalid = !from || !to || to < from;
  const unchanged = from === entry.dateFrom && to === entry.dateTo && time === entry.timePreference;
  const summary = `${shortDate(entry.dateFrom)} to ${shortDate(entry.dateTo)} · ${entry.timePreference}`;
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) { setFrom(entry.dateFrom); setTo(entry.dateTo); setTime(entry.timePreference); } }}>
      <EditTrigger label={`Change wanted dates for ${name}, currently ${summary}`}>{summary}</EditTrigger>
      <PopoverPopup align="start" className="w-72">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            From
            <Input type="date" aria-label="Wanted from" className="tabular-nums" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            To
            <Input type="date" aria-label="Wanted to" className="tabular-nums" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
          </label>
          <div className="flex flex-col gap-1 text-xs font-medium">
            Time of day
            <Select value={time} onValueChange={(next) => { if (next) setTime(next as WaitlistEntry["timePreference"]); }} items={timePreferences}>
              <SelectTrigger size="sm" aria-label="Time of day"><SelectValue /></SelectTrigger>
              <SelectPopup>{timePreferences.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
            </Select>
          </div>
          {to && from && to < from ? <p role="alert" className="text-xs text-destructive-foreground">End date must be on or after the start date.</p> : null}
          <Button size="sm" loading={busy} disabled={invalid || unchanged} onClick={() => {
            setBusy(true);
            void onSave({ ...(from !== entry.dateFrom ? { dateFrom: from } : {}), ...(to !== entry.dateTo ? { dateTo: to } : {}), ...(time !== entry.timePreference ? { timePreference: time } : {}) })
              .then((ok) => { setBusy(false); if (ok) setOpen(false); });
          }}>Save wanted dates</Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function QueueEmpty({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <Empty className="p-4 md:p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

function PersonCell({ name, meta, badge }: { name: string; meta: React.ReactNode; badge: React.ReactNode }) {
  return (
    <span className="flex items-center gap-3">
      <PersonAvatar name={name} />
      <span className="flex min-w-0 flex-col items-start gap-0.5">
        <span className="text-sm font-medium">{name}</span>
        <span className="text-xs text-muted-foreground md:hidden">{meta}</span>
        <span className="sm:hidden">{badge}</span>
      </span>
    </span>
  );
}

export function FollowUpsWorkspace() {
  const features = useFeatures();
  if (!features.recalls) {
    return (
      <WorkspacePage nav="follow-ups">
        <WorkspaceFrame>
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><BellRing aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>Follow-ups are turned off</EmptyTitle>
            <EmptyDescription>Turn them on in Settings, Business profile.</EmptyDescription>
          </EmptyHeader>
        </Empty>
        </WorkspaceFrame>
      </WorkspacePage>
    );
  }
  return <FollowUpsTasks />;
}

function FollowUpsTasks() {
  const t = useTerms();
  const { appointments, operations, database, patients } = usePreviewAppointments();
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const { can } = useStaffAccess();
  const canOffer = !database || can("waitlist.manage");
  const offerKey = useRef(typeof crypto !== "undefined" ? crypto.randomUUID() : "offer-key");
  const [tab, setTab] = useState<Tab>("waitlist");
  const [step, setStep] = useState<Step>("browse");
  const [task, setTask] = useState<Task | null>(null);
  const [slot, setSlot] = useState<TimeSlot | null>(null);
  const [waitlistEdits, setWaitlistEdits] = useState<Record<string, WaitlistPatch>>({});
  const [recalls, setRecalls] = useState(initialRecalls);
  const [decision, setDecision] = useState<"offer" | "pause" | "reminder" | "snooze">("offer");
  const [remoteSlots, setRemoteSlots] = useState<TimeSlot[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const titleRef = useRef<HTMLSpanElement>(null);
  const waitlist = useMemo(() => database ? staff?.snapshot?.waitlist ?? [] : demoWaitlist.map((item) => ({ ...item, ...waitlistEdits[item.id] })), [database, staff?.snapshot?.waitlist, waitlistEdits]);
  const visibleRecalls = database ? staff?.snapshot?.recalls ?? [] : recalls;

  useEffect(() => { if (step !== "browse") titleRef.current?.focus(); }, [step]);
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const saved = window.sessionStorage.getItem("kalendr-preview-followups-v1");
        if (!saved) return;
        const parsed: unknown = JSON.parse(saved);
        if (typeof parsed !== "object" || parsed === null) return;
        const state = parsed as Record<string, unknown>;
        if (typeof state.waitlistEdits === "object" && state.waitlistEdits !== null) setWaitlistEdits(state.waitlistEdits as Record<string, WaitlistPatch>);
        else if (typeof state.waitlistStates === "object" && state.waitlistStates !== null) {
          setWaitlistEdits(Object.fromEntries(Object.entries(state.waitlistStates as Record<string, string>).map(([id, value]) => [id, { status: value === "offered" ? "offered" : value === "paused" ? "declined" : "active" } as WaitlistPatch])));
        }
        if (Array.isArray(state.recalls) && state.recalls.every((item) => typeof item === "object" && item !== null && typeof item.id === "string" && typeof item.status === "string")) setRecalls(state.recalls as Recall[]);
      } catch (error: unknown) {
        console.error("Could not load preview follow-ups", error);
      }
    });
  }, []);

  const entry = task?.kind === "waitlist" ? waitlist.find((item) => item.id === task.id) : undefined;
  const recall = task?.kind === "recall" ? visibleRecalls.find((item) => item.id === task.id) : undefined;
  const patient = patients.find((item) => item.id === (entry?.patientId ?? recall?.patientId ?? "")) ?? getPatient(entry?.patientId ?? recall?.patientId ?? "");
  const service = catalog.getService(entry?.serviceId ?? recall?.serviceId ?? "");
  const name = patient ? `${patient.firstName} ${patient.lastName}`.trim() : entry ? waitlistNames.get(entry.id) ?? t.Customer : t.Customer;
  const previewSlots = !database && entry && service ? compatibleSlots({ service, locationId: entry.locationId, appointments, patientId: entry.patientId, waitlist: entry, availability: operations.schedule }) : [];
  const slots = database ? remoteSlots : previewSlots;

  useEffect(() => {
    if (!database || !entry || !service) return;
    const controller = new AbortController();
    const bounds = { from: `${entry.dateFrom}T00:00:00+05:30`, to: `${entry.dateTo}T23:59:59+05:30` };
    void fetchAvailabilitySlots({
      clinicSlug: catalog.clinic.slug,
      locationId: entry.locationId,
      serviceId: service.id,
      from: bounds.from,
      to: bounds.to,
    }, controller.signal).then((nextSlots) => { if (!controller.signal.aborted) setRemoteSlots(nextSlots); })
      .catch(() => { if (!controller.signal.aborted) setRemoteSlots([]); });
    return () => controller.abort();
  }, [catalog.clinic.slug, database, entry, service]);

  function open(nextTask: Task) { setTask(nextTask); setSlot(null); setStep("choose"); setDecision(nextTask.kind === "waitlist" ? "offer" : "reminder"); }
  function back() { if (step === "review") setStep("choose"); else { setStep("browse"); setTask(null); } }
  function commit() {
    if (database) {
      setPending(true);
      void (async () => {
        try {
          if (task?.kind === "waitlist" && entry && decision === "offer" && slot) {
            // Feature 21: a real offer. The time is held for this person, the message goes out, and the next person is asked if they do not answer.
            await staffMutation(`/api/staff/waitlist/${entry.id}/offer`, "POST", { practitionerId: slot.practitionerId, startsAt: slot.startsAt, endsAt: slot.endsAt }, { idempotencyKey: offerKey.current });
            offerKey.current = crypto.randomUUID();
          } else if (task?.kind === "waitlist" && entry) {
            await staffMutation(`/api/staff/waitlist/${entry.id}`, "PATCH", {
              status: decision === "pause" ? "declined" : "offered",
            });
          } else if (task?.kind === "recall" && recall) {
            await staffMutation(`/api/staff/recalls/${recall.id}`, "PATCH", {
              status: decision === "snooze" ? "snoozed" : "contacted",
            });
          }
          await staff?.refresh();
          setError("");
          setStep("result");
        } catch (cause: unknown) {
          setError(cause instanceof Error ? cause.message : "The follow-up could not be saved.");
        } finally {
          setPending(false);
        }
      })();
      return;
    }
    const nextEdits: Record<string, WaitlistPatch> = task?.kind === "waitlist" && entry ? { ...waitlistEdits, [entry.id]: { ...waitlistEdits[entry.id], status: decision === "pause" ? "declined" : "offered" } } : waitlistEdits;
    const nextRecalls: Recall[] = task?.kind === "recall" && recall ? recalls.map((item) => item.id === recall.id ? { ...item, status: decision === "snooze" ? "snoozed" : "contacted" } : item) : recalls;
    savePreview(nextEdits, nextRecalls);
    setStep("result");
  }

  function savePreview(nextEdits: Record<string, WaitlistPatch>, nextRecalls: Recall[]) {
    try {
      window.sessionStorage.setItem("kalendr-preview-followups-v1", JSON.stringify({ waitlistEdits: nextEdits, recalls: nextRecalls }));
    } catch (saveError: unknown) {
      console.error("Could not save preview follow-ups", saveError);
    }
    setWaitlistEdits(nextEdits);
    setRecalls(nextRecalls);
  }

  /** Runs one in-place change, in the database or the preview store. Resolves true when it was stored. */
  async function change(path: string, body: RecallPatch | WaitlistPatch, applyPreview: () => void): Promise<boolean> {
    try {
      if (database) {
        await staffMutation(path, "PATCH", body);
        await staff?.refresh();
      } else applyPreview();
      toastManager.add({ title: "Saved", type: "success" });
      return true;
    } catch (cause: unknown) {
      toastManager.add({ title: cause instanceof Error ? cause.message : "The change could not be saved.", type: "error" });
      return false;
    }
  }
  function saveRecall(id: string, patch: RecallPatch) {
    const body = patch.dueAt ? { ...patch, dueAt: patch.dueAt.slice(0, 10) } : patch;
    return change(`/api/staff/recalls/${id}`, body, () => savePreview(waitlistEdits, recalls.map((item) => item.id === id ? {
      ...item, ...(patch.status ? { status: patch.status } : {}), ...(patch.dueAt ? { dueAt: `${patch.dueAt.slice(0, 10)}T09:00:00+05:30` } : {}),
    } : item)));
  }
  function saveWaitlist(id: string, patch: WaitlistPatch) {
    return change(`/api/staff/waitlist/${id}`, patch, () => savePreview({ ...waitlistEdits, [id]: { ...waitlistEdits[id], ...patch } }, recalls));
  }

  const errorAlert = error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null;

  if (step === "browse") {
    return (
      <WorkspacePage nav="follow-ups">
        <Tabs value={tab} onValueChange={(item) => setTab(item as Tab)} className="gap-0">
          <WorkspaceFrame
            flush={tab !== "offers"}
            footer={tab === "waitlist" && !database ? <p className="text-xs text-muted-foreground">{demoQueues.filter((item) => item.kind === "waitlist" && !demoWaitlist.some((entry) => item.id.replace("queue_", "waitlist_") === entry.id)).length} illustrative waitlist item has no linked entry and cannot be offered a time.</p> : null}
            start={
          <TabsList variant="underline" aria-label="Follow-up queues">
            <TabsTab value="waitlist">Waitlist <Badge variant="outline" className="tabular-nums">{waitlist.length}</Badge></TabsTab>
            {database && can("appointments.book") ? <TabsTab value="offers">Offers</TabsTab> : null}
            <TabsTab value="recalls">Recalls <Badge variant="outline" className="tabular-nums">{visibleRecalls.length}</Badge></TabsTab>
          </TabsList>
            }
          >

          <TabsPanel value="waitlist">
            <section aria-label="Waitlist entries">
                  {waitlist.length ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t.Customer}</TableHead>
                          <TableHead className="hidden md:table-cell">Service</TableHead>
                          <TableHead className="hidden md:table-cell">Requested window</TableHead>
                          <TableHead className="hidden sm:table-cell">Status</TableHead>
                          <TableHead><span className="sr-only">Review</span></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {waitlist.map((item) => {
                          const person = patients.find((patient) => patient.id === item.patientId) ?? getPatient(item.patientId);
                          const personName = person ? `${person.firstName} ${person.lastName}`.trim() : waitlistNames.get(item.id) ?? t.Customer;
                          const window = `${shortDate(item.dateFrom)} to ${shortDate(item.dateTo)} · ${item.timePreference}`;
                          const badge = <StatusBadge tone={item.status === "active" ? "attention" : "neutral"}>{waitlistLabels[item.status]}</StatusBadge>;
                          return (
                            <TableRow key={item.id} className="cursor-pointer" onClick={() => open({ kind: "waitlist", id: item.id })}>
                              <TableHead scope="row" className="h-auto whitespace-normal py-2 font-normal text-foreground">
                                <PersonCell name={personName} meta={`${catalog.serviceName(item.serviceId)} · ${window}`} badge={badge} />
                              </TableHead>
                              <TableCell className="hidden md:table-cell">{catalog.serviceName(item.serviceId)}</TableCell>
                              <TableCell className="hidden md:table-cell"><div onClick={(event) => event.stopPropagation()}><WindowEditor entry={item} name={personName} onSave={(patch) => saveWaitlist(item.id, patch)} /></div></TableCell>
                              <TableCell className="hidden sm:table-cell">{badge}</TableCell>
                              <TableCell className="w-28 text-end">
                                <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
                                  <Button size="sm" variant="ghost" aria-label={`Review ${personName}`} onClick={() => open({ kind: "waitlist", id: item.id })}>
                                    Review <ChevronRight aria-hidden="true" />
                                  </Button>
                                  <ActionMenuButton label={`Change status for ${personName}`} iconOnly variant="ghost" icon={<Ellipsis />} items={waitlistMoves(item.status, (patch) => void saveWaitlist(item.id, patch))} />
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  ) : <QueueEmpty icon={<ListChecks aria-hidden="true" />} title={database ? `No waitlist entries for this ${t.business}.` : "No waitlist entries in this preview."} />}
            </section>
          </TabsPanel>

          {database && can("appointments.book") ? <TabsPanel value="offers"><WaitlistOffersPanel /></TabsPanel> : null}

          <TabsPanel value="recalls">
            <section aria-label="Recalls">
                  {visibleRecalls.length ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t.Customer}</TableHead>
                          <TableHead className="hidden md:table-cell">Service</TableHead>
                          <TableHead className="hidden md:table-cell">Due</TableHead>
                          <TableHead className="hidden sm:table-cell">Status</TableHead>
                          <TableHead><span className="sr-only">Review</span></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleRecalls.map((item) => {
                          const person = patients.find((patient) => patient.id === item.patientId) ?? getPatient(item.patientId);
                          const personName = person ? `${person.firstName} ${person.lastName}`.trim() : t.Customer;
                          const badge = <StatusBadge tone={item.status === "overdue" ? "attention" : "neutral"}>{recallLabels[item.status]}</StatusBadge>;
                          return (
                            <TableRow key={item.id} className="cursor-pointer" onClick={() => open({ kind: "recall", id: item.id })}>
                              <TableHead scope="row" className="h-auto whitespace-normal py-2 font-normal text-foreground">
                                <PersonCell name={personName} meta={`${catalog.serviceName(item.serviceId)} · due ${shortDate(item.dueAt)}`} badge={badge} />
                              </TableHead>
                              <TableCell className="hidden md:table-cell">{catalog.serviceName(item.serviceId)}</TableCell>
                              <TableCell className="hidden md:table-cell"><div onClick={(event) => event.stopPropagation()}><DueDateEditor value={item.dueAt} name={personName} onSave={(dateKey) => saveRecall(item.id, { dueAt: dateKey })} /></div></TableCell>
                              <TableCell className="hidden sm:table-cell">{badge}</TableCell>
                              <TableCell className="w-28 text-end">
                                <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
                                  <Button size="sm" variant="ghost" aria-label={`Review ${personName}`} onClick={() => open({ kind: "recall", id: item.id })}>
                                    Review <ChevronRight aria-hidden="true" />
                                  </Button>
                                  <ActionMenuButton label={`Change status for ${personName}`} iconOnly variant="ghost" icon={<Ellipsis />} items={recallMoves(item.status, (patch) => void saveRecall(item.id, patch))} />
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  ) : <QueueEmpty icon={<BellRing aria-hidden="true" />} title={database ? `No recalls for this ${t.business}.` : "No recalls in this preview."} />}
            </section>
          </TabsPanel>
          </WorkspaceFrame>
        </Tabs>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage
      back={{ label: step === "review" ? "Back to choices" : "Back to follow-ups", onClick: back }}
      title={<span ref={titleRef} tabIndex={-1} className="outline-none">{step === "result" ? "Follow-up recorded" : step === "review" ? "Review follow-up" : task?.kind === "waitlist" ? "Prepare a waitlist offer" : "Prepare a recall reminder"}</span>}
    >
      <WorkspaceFrame
        start={<p className="min-w-0 truncate px-1 text-sm font-medium">{name} · {service?.name}</p>}
        panelClassName="gap-4"
      >
      <TaskSteps label="Follow-up task progress" steps={["Prepare", "Review", "Result"]} current={step === "choose" ? 0 : step === "review" ? 1 : 2} complete={step === "result"} />

      {step === "choose" ? (
        <div className="flex flex-col gap-4">
          {errorAlert}
          <Card>
            <CardPanel>
              <dl className="grid gap-4 sm:grid-cols-3">
                <Fact label="Preferred contact">{patient ? channelLabel(patient.preferredChannel) : "Not recorded"}</Fact>
                <Fact label="Service">{service?.name}</Fact>
                {entry ? <Fact label="Requested dates"><WindowEditor entry={entry} name={name} onSave={(patch) => saveWaitlist(entry.id, patch)} /></Fact> : null}
                {recall ? <Fact label="Due"><DueDateEditor value={recall.dueAt} name={name} onSave={(dateKey) => saveRecall(recall.id, { dueAt: dateKey })} /></Fact> : null}
                {entry || recall ? (
                  <Fact label="Status">
                    <span className="flex items-center gap-2">
                      {entry ? waitlistLabels[entry.status] : recall ? recallLabels[recall.status] : null}
                      <ActionMenuButton label={`Change status for ${name}`} iconOnly variant="ghost" icon={<Ellipsis />} items={entry ? waitlistMoves(entry.status, (patch) => void saveWaitlist(entry.id, patch)) : recall ? recallMoves(recall.status, (patch) => void saveRecall(recall.id, patch)) : []} />
                    </span>
                  </Fact>
                ) : null}
              </dl>
            </CardPanel>
          </Card>
          {entry ? (
            <Card>
              <CardHeader>
                <h2 className="text-sm font-medium">Compatible openings</h2>
                <p className="text-xs text-muted-foreground">Openings match the service, location, resource, date and time preferences.{database ? ` Offering holds the time for the ${t.customer} and messages them. It leaves the booking page until they answer.` : ""}</p>
              </CardHeader>
              <CardPanel>
                {!canOffer ? (
                  <Alert variant="info"><AlertDescription>You can see the openings but need the waitlist permission to offer one. Ask the owner.</AlertDescription></Alert>
                ) : slots.length ? (
                  <ScrollArea role="region" aria-label="Compatible openings" className="flex h-auto! max-h-96 flex-col">
                  <div className="grid gap-2 p-px sm:grid-cols-2 lg:grid-cols-3">
                    {slots.map((opening) => (
                      <OpeningButton
                        key={opening.id}
                        selected={slot?.id === opening.id}
                        time={appointmentDateTime(opening.startsAt)}
                        meta={catalog.practitionerName(opening.practitionerId)}
                        onClick={() => { setSlot(opening); setDecision("offer"); setStep("review"); }}
                      />
                    ))}
                  </div>
                  </ScrollArea>
                ) : <QueueEmpty icon={<CalendarOff aria-hidden="true" />} title={database ? "No compatible opening. You can close this entry." : "No compatible opening in the preview. You can pause this entry."} />}
              </CardPanel>
              <CardFooter className="flex flex-row">
                <Button size="sm" variant="outline" onClick={() => { setDecision("pause"); setStep("review"); }}>{database ? "Close waitlist entry" : "Pause waitlist entry"}</Button>
              </CardFooter>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <h2 className="text-sm font-medium">Message preview</h2>
                <p className="text-xs text-muted-foreground">{database ? "No message is sent. This records a prepared reminder only." : "No message is sent in preview. This records a prepared reminder only."}</p>
              </CardHeader>
              <CardPanel>
                <p className="text-sm">Your {t.business} has a routine scheduling reminder. Please contact the {t.business} when convenient.</p>
              </CardPanel>
              <CardFooter className="flex flex-row flex-wrap gap-2">
                <Button size="sm" onClick={() => { setDecision("reminder"); setStep("review"); }}>Review reminder</Button>
                <Button size="sm" variant="outline" onClick={() => { setDecision("snooze"); setStep("review"); }}>Snooze recall</Button>
              </CardFooter>
            </Card>
          )}
        </div>
      ) : null}

      {step === "review" ? (
        <div className="flex flex-col gap-4">
          {errorAlert}
          <Card>
            <CardHeader>
              <h2 className="text-sm font-medium">{decision === "offer" ? "Waitlist offer" : decision === "pause" ? database ? "Close waitlist entry" : "Pause waitlist entry" : decision === "snooze" ? "Snooze recall" : "Recall reminder"}</h2>
            </CardHeader>
            <CardPanel className="flex flex-col gap-4">
              <dl className="grid gap-4 sm:grid-cols-2">
                <Fact label={t.Customer}>{name}</Fact>
                <Fact label="Service">{service?.name}</Fact>
                {slot && decision === "offer" ? <>
                  <Fact label="Proposed time"><span className="tabular-nums">{appointmentDateTime(slot.startsAt)}</span></Fact>
                  <Fact label={t.Practitioner}>{catalog.practitionerName(slot.practitionerId)}</Fact>
                </> : null}
              </dl>
              <p className="text-xs text-muted-foreground">{database ? (decision === "offer" ? `This holds the time for the ${t.customer} and sends them the offer. They have 15 minutes (5 inside 3 hours) before the next person is asked.` : `This records the follow-up for the ${t.business}. It does not send a message or reserve a time.`) : "This preview records the preparation locally. It does not send a message or reserve a time."}</p>
            </CardPanel>
            <CardFooter className="flex flex-row flex-wrap justify-between gap-2">
              <Button size="sm" variant="outline" onClick={() => setStep("choose")}>Change choice</Button>
              <Button size="sm" onClick={commit} loading={pending}>{`Confirm ${decision === "offer" ? "offer" : decision === "reminder" ? "reminder" : decision}`}</Button>
            </CardFooter>
          </Card>
        </div>
      ) : null}

      {step === "result" ? (
        <Card role="status">
          <CardPanel className="flex items-start gap-3">
            <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success-foreground" />
            <div className="flex flex-col items-start gap-1">
              <h2 className="font-heading text-base font-semibold">{decision === "offer" ? (database ? "Offer sent" : "Offer prepared") : decision === "reminder" ? "Reminder prepared" : decision === "pause" ? database ? "Waitlist closed" : "Waitlist paused" : "Recall snoozed"}</h2>
              <p className="text-sm text-muted-foreground">{database ? (decision === "offer" ? `The time is held for the ${t.customer} and the offer is on its way. You can follow it on the Offers tab.` : `Saved for this ${t.business}. No ${t.customer} message was delivered.`) : `Saved in this preview only. No ${t.customer} message was delivered.`}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => { setStep("browse"); setTask(null); }}>Back to follow-ups</Button>
            </div>
          </CardPanel>
        </Card>
      ) : null}
      </WorkspaceFrame>
    </WorkspacePage>
  );
}
