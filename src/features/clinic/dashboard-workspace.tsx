"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlarmClock,
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  ChartNoAxesColumn,
  DoorClosed,
  Columns3,
  EyeOff,
  FastForward,
  FileWarning,
  Flag,
  Footprints,
  GanttChart,
  Hourglass,
  IndianRupee,
  Keyboard,
  LayoutGrid,
  Lock,
  Megaphone,
  Plus,
  QrCode,
  Rows3,
  Settings2,
  Stethoscope,
  StickyNote,
  Timer,
  Tv,
} from "lucide-react";
import { useRouter } from "next/navigation";

import { type ActionMenuEntry, type BarAction } from "@/components/action-bar";
import { CustomizeSheet, layoutOption, type CustomizeList, type CustomizeOption } from "@/components/customize-sheet";
import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { toastManager } from "@/components/ui/toast";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { isClinicalBusinessType } from "@/lib/business-types";
import { demoAppointments } from "@/lib/demo-data";
import type { Appointment, QueueTicket } from "@/lib/domain";
import { quickMessageLabel, type QuickMessageKind } from "@/lib/quick-messages";
import { arrangeList, visibleList, withListLayout, type PageLayout } from "@/lib/workspace-layout";

import { useCatalogLookups } from "./clinic-catalog";
import { appointmentEvent, practitionerLanes } from "./clinic-calendar-events";
import { appointmentTime } from "./clinic-format";
import { appointmentPatientName, dayVisits, waitingMinutes } from "./clinic-today";
import { DayEndDialog } from "./day-end-dialog";
import { cn } from "@/lib/utils";

import { OnboardingChecklist } from "./onboarding-checklist";
import { useNewVisit } from "./new-visit-sheet";
import { PaymentsDialog } from "./payments-dialog";
import { clinicDateKey, usePreviewAppointments, type QueueAction } from "./preview-appointments";
import { CloseQueueDialog, DoorLinkDialog, PhoneLinkDialog, ScreenLinkDialog } from "./queue-link-dialog";
import { RunningLateDialog } from "./running-late-dialog";
import { useStaffAccess } from "./staff-access";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { QueueBoard, type BoardColumn } from "./queue-board";
import { QueueFilterBar, type FilterGroup, type ViewChoice } from "./queue-filter-bar";
import { HandoverPanel, HeardFromPanel, Overview, UrgentDialog, type Tile } from "./today-panels";
import { stageOf, visitFlags, type FlagId, type QuickStep, type Stage, type VisitHandlers } from "./today-queue-card";
import { useHandoverNotes } from "./use-handover-notes";
import { useQueue } from "./use-queue";
import { useQuickMessages } from "./use-quick-messages";
import { useScheduleAvailability } from "./use-visits-needing-person";
import { TodayTracker } from "./today-tracker";
import { usePageLayout } from "./workspace-layout-provider";

// The timeline view draws the full calendar, which is heavy; most days open on the board.
const DayTimeline = dynamic(() => import("./clinic-calendar").then((m) => m.DayTimeline), { ssr: false, loading: () => <Skeleton className="size-full rounded-none" /> });

type Panel = null | "heard" | "handover" | "customize" | "late" | "dayend" | "screen" | "door" | "closequeue" | "keys";
type View = "queue" | "lanes" | "timeline";
const views: View[] = ["queue", "lanes", "timeline"];

/** The flags the filter row can narrow to, in the order they matter at the desk. */
const flagChoices: { id: FlagId; label: string; Icon: typeof Flag }[] = [
  { id: "urgent", label: "Urgent", Icon: Flag },
  { id: "long_wait", label: "Waiting 15+ min", Icon: Hourglass },
  { id: "called", label: "Called", Icon: Megaphone },
  { id: "late", label: "Running late", Icon: AlarmClock },
  { id: "request", label: "Needs approval", Icon: CalendarClock },
  { id: "form", label: "Form not done", Icon: FileWarning },
  { id: "due", label: "Payment due", Icon: IndianRupee },
  { id: "walk_in", label: "Walk-in", Icon: Footprints },
];

const shortcuts: { keys: string[]; label: string }[] = [
  { keys: ["/"], label: "Search" },
  { keys: ["C"], label: "Add walk-in" },
  { keys: ["J"], label: "Next card" },
  { keys: ["K"], label: "Previous card" },
  { keys: ["Enter"], label: "Open the details" },
  { keys: ["Space"], label: "Pick up a card, then drop it" },
  { keys: ["←", "→"], label: "Move a picked-up card" },
  { keys: ["Esc"], label: "Cancel or close" },
  { keys: ["?"], label: "Show these shortcuts" },
];

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest("input, textarea, select, [role=dialog], [role=menu], [role=listbox]"));
}

export function DashboardWorkspace() {
  const { appointments, patients, operations, advancePreviewClock, database } = usePreviewAppointments();
  const handover = useHandoverNotes("Preview staff");
  const messages = useQuickMessages();
  const t = useTerms();
  const profile = useBusinessProfile();
  const scheduleHours = useScheduleAvailability();
  const catalog = useCatalogLookups();
  const router = useRouter();
  const { openNewVisit } = useNewVisit();
  const { layout, canEdit, update } = usePageLayout("today");
  const storedView = layoutOption<string>(layout, "defaultView", "queue");
  const defaultView: View = views.includes(storedView as View) ? (storedView as View) : "queue";
  const showOverview = layoutOption(layout, "showOverview", false);
  const waitingLimitChoice = Number(layoutOption<string>(layout, "waitingLimit", "off"));
  const waitingLimit = Number.isFinite(waitingLimitChoice) && waitingLimitChoice > 0 ? waitingLimitChoice : undefined;
  const [search, setSearch] = useState("");
  const [practitionerIds, setPractitionerIds] = useState<string[]>([]);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [roomIds, setRoomIds] = useState<string[]>([]);
  const [flagIds, setFlagIds] = useState<string[]>([]);
  // Running late and Call next act for one person only when exactly one is picked.
  const practitionerFilter = practitionerIds.length === 1 ? practitionerIds[0] : "";
  const searchRef = useRef<HTMLInputElement>(null);
  // Someone picking a view wins; otherwise the page opens the way the team set it.
  const [chosenView, setView] = useState<View | null>(null);
  const view = chosenView ?? defaultView;
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState("");
  const clinical = isClinicalBusinessType(profile.businessType);

  const dayKey = database ? clinicDateKey(operations.clockIso) : clinicDateKey(demoAppointments[0].startsAt);
  const clockIso = operations.clockIso;
  const staff = useOptionalStaffSnapshot();
  const access = useStaffAccess();
  const canMove = database && access.can("appointments.status");
  const canPay = database && access.can("payments.collect");
  const canCloseDay = database && access.can("payments.close_day");
  const [payingId, setPayingId] = useState<string | null>(null);
  const payingAppointment = payingId ? appointments.find((appointment) => appointment.id === payingId) : undefined;
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Saves a visit's next step from its card, then reloads the day. */
  async function runStep(appointment: Appointment, step: QuickStep, name: string): Promise<boolean> {
    const expectedVersion = staff?.snapshot?.appointments.find((item) => item.id === appointment.id)?.version;
    if (!expectedVersion) return false;
    const done: Record<QuickStep, string> = { checkin: "Checked in", start: `${t.Visit} started`, complete: `${t.Visit} finished`, no_show: "Marked no-show", left: "Left without being seen" };
    setBusyId(appointment.id);
    try {
      if (step === "start") {
        await staffMutation(`/api/staff/appointments/${appointment.id}`, "PATCH", { action: "start", expectedVersion });
      } else if (step === "left") {
        await staffMutation(`/api/appointments/${appointment.id}/status`, "PATCH", { status: "cancelled", reason: "Left without being seen", expectedVersion });
      } else {
        const status = { checkin: "checked_in", complete: "completed", no_show: "no_show" }[step];
        await staffMutation(`/api/appointments/${appointment.id}/status`, "PATCH", { status, expectedVersion });
      }
      await staff?.refresh();
      toastManager.add({ title: `${done[step]} · ${name}`, description: `No ${t.customer} notification was sent.`, type: "success" });
      return true;
    } catch (cause: unknown) {
      await staff?.refresh();
      toastManager.add({ title: `Could not save · ${name}`, description: cause instanceof Error ? cause.message : "Refresh and try again.", type: "error" });
      return false;
    } finally {
      setBusyId(null);
    }
  }
  const queue = useQueue();
  const canQueue = database ? access.can("appointments.status") : true;
  const [calling, setCalling] = useState(false);
  const [urgentFor, setUrgentFor] = useState<Appointment | null>(null);
  const [linkTicket, setLinkTicket] = useState<QueueTicket | null>(null);

  /** Calls the next waiting customer: urgent first, then booked customers who are due, then by token. */
  async function callNext() {
    setCalling(true);
    try {
      const called = await queue.callNext(practitionerFilter || undefined);
      if (!called) {
        toastManager.add({ title: "No one is waiting", description: practitionerFilter ? `No one is waiting for ${catalog.practitionerName(practitionerFilter)}.` : undefined });
        return;
      }
      const visit = appointments.find((item) => item.id === called.appointmentId);
      toastManager.add({ title: `Calling #${called.number}${visit ? ` · ${appointmentPatientName(visit, patients, t)}` : ""}`, description: visit ? placeOf(visit) : undefined, type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not call next", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
    } finally {
      setCalling(false);
    }
  }

  async function runQueue(appointment: Appointment, action: QueueAction, reason?: string) {
    if (action === "urgent" && !reason) {
      setUrgentFor(appointment);
      return;
    }
    const name = appointmentPatientName(appointment, patients, t);
    const number = appointment.queue?.number;
    const done: Record<QueueAction, string> = { call_again: `Calling #${number}`, skip: `Skipped #${number}`, urgent: `#${number} marked urgent`, not_urgent: `#${number} no longer urgent` };
    setBusyId(appointment.id);
    try {
      await queue.act(appointment, action, reason);
      toastManager.add({ title: `${done[action]} · ${name}`, type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: `Could not save · ${name}`, description: cause instanceof Error ? cause.message : "Refresh and try again.", type: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function runMessage(appointment: Appointment, kind: QuickMessageKind, delayMinutes?: number) {
    const name = appointmentPatientName(appointment, patients, t);
    setBusyId(appointment.id);
    try {
      await messages.send(appointment, kind, delayMinutes);
      toastManager.add({ title: `Sent "${quickMessageLabel(kind)}" · ${name}`, description: delayMinutes ? `About ${delayMinutes} min late` : undefined, type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: `Could not send · ${name}`, description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
    } finally {
      setBusyId(null);
    }
  }

  const timings = operations.visitTimings;
  const allVisits = useMemo(() => dayVisits(appointments, dayKey), [appointments, dayKey]);

  const normalizedSearch = search.trim().toLocaleLowerCase("en-IN");
  const flagsOf = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const appointment of allVisits) {
      map.set(appointment.id, new Set(visitFlags(stageOf(appointment, timings), appointment, timings[appointment.id], clockIso, catalog.clinic.currency).map((flag) => flag.id)));
    }
    return map;
  }, [allVisits, timings, clockIso, catalog.clinic.currency]);

  // Each filter's counts are taken with every other filter applied, so a count is what picking it would show.
  type Facet = "search" | "practitioner" | "service" | "room" | "flag";
  const passes = (appointment: Appointment, skip?: Facet) => {
    if (skip !== "search" && normalizedSearch) {
      const patient = patients.find((item) => item.id === appointment.patientId);
      const queueToken = appointment.queue ? `#${appointment.queue.number}` : "";
      const haystack = [patient?.firstName, patient?.lastName, patient?.phone, queueToken, appointment.patientId, appointment.id].join(" ").toLocaleLowerCase("en-IN");
      if (!haystack.includes(normalizedSearch)) return false;
    }
    if (skip !== "practitioner" && practitionerIds.length && !practitionerIds.includes(appointment.practitionerId)) return false;
    if (skip !== "service" && serviceIds.length && !serviceIds.includes(appointment.serviceId)) return false;
    if (skip !== "room" && roomIds.length && !appointment.resourceIds.some((id) => roomIds.includes(id))) return false;
    if (skip !== "flag" && flagIds.length) {
      const flags = flagsOf.get(appointment.id);
      if (!flagIds.some((id) => flags?.has(id))) return false;
    }
    return true;
  };
  const visible = allVisits.filter((appointment) => passes(appointment));
  const countWhere = (skip: Facet, match: (appointment: Appointment) => boolean) => allVisits.filter((appointment) => passes(appointment, skip) && match(appointment)).length;

  // Whole-day overview, independent of the filters.
  const byStage = (visits: Appointment[], stage: Stage) => visits.filter((appointment) => stageOf(appointment, timings) === stage);
  const dayWaiting = byStage(allVisits, "waiting");
  const dayUpNext = byStage(allVisits, "up_next");
  const dayDone = byStage(allVisits, "done").length;
  const longestWait = dayWaiting.reduce((longest, appointment) => {
    const at = timings[appointment.id]?.checkedInAt;
    return at ? Math.max(longest, waitingMinutes(at, clockIso)) : longest;
  }, 0);
  const nextArrival = dayUpNext.find((appointment) => Date.parse(appointment.startsAt) >= Date.parse(clockIso)) ?? dayUpNext[0];

  const canAdvance = Date.parse(clockIso) < Date.parse(`${dayKey}T18:00:00+05:30`);
  const open = (next: Panel) => () => setPanel(next);
  const panelProps = (id: Exclude<Panel, null>) => ({ open: panel === id, onOpenChange: (next: boolean) => setPanel(next ? id : null) });

  // ── What the team can arrange on this page ─────────────────────────────
  const headerActions: (BarAction & { description: string })[] = [
    ...(canQueue ? [
      { id: "late", label: "Running late…", description: "Tell everyone still to be seen today", icon: <Timer aria-hidden="true" />, onSelect: open("late"), priority: 4, iconOnly: true },
    ] : []),
    ...(canQueue ? [
      { id: "call", label: "Call next", description: "Urgent first, then by token", icon: <Megaphone aria-hidden="true" />, variant: "default" as const, badge: dayWaiting.filter((item) => item.queue && !item.queue.calledAt).length || undefined, disabled: calling, onSelect: () => void callNext(), pinned: true },
    ] : []),
  ];

  // Less frequent, end-of-shift and setup actions: always in ⋯.
  const moreMenu: ActionMenuEntry[] = [
    { id: "handover", label: "Handover", icon: <StickyNote aria-hidden="true" />, hint: handover.notes.length || undefined, onSelect: open("handover") },
    { id: "heard", label: "How people found you", icon: <ChartNoAxesColumn aria-hidden="true" />, onSelect: open("heard") },
    ...(canQueue && database ? [{ id: "screen", label: "Waiting-room screen…", icon: <Tv aria-hidden="true" />, onSelect: open("screen") }] : []),
    ...(canQueue && database && access.can("settings.manage") ? [{ id: "door", label: "Door QR code…", icon: <QrCode aria-hidden="true" />, onSelect: open("door") }] : []),
    ...(canQueue && database ? [{ id: "closequeue", label: "Close the queue…", icon: <DoorClosed aria-hidden="true" />, onSelect: open("closequeue") }] : []),
    ...(canCloseDay ? [{ id: "dayend", label: "Day end…", icon: <Lock aria-hidden="true" />, onSelect: open("dayend") }] : []),
    ...(database ? [] : [{ id: "advance", label: "Advance 15 min", icon: <FastForward aria-hidden="true" />, disabled: !canAdvance, onSelect: () => { if (!advancePreviewClock(15)) setError("Could not advance the preview clock in this browser."); } }]),
    { id: "keys", label: "Keyboard shortcuts", icon: <Keyboard aria-hidden="true" />, hint: "?", onSelect: open("keys") },
    { id: "sep-customize", kind: "separator" },
  ];

  const tiles: Tile[] = [
    { id: "arriving", label: "Still to arrive", value: dayUpNext.length, hint: nextArrival ? `Next ${appointmentTime(nextArrival.startsAt)}` : undefined },
    { id: "waiting", label: "Waiting", value: dayWaiting.length, hint: longestWait ? `Longest ${longestWait} min` : undefined, attention: longestWait >= 15 },
    { id: "with", label: `With ${t.practitioner}`, value: allVisits.length - dayUpNext.length - dayWaiting.length - dayDone },
    { id: "done", label: "Done", value: dayDone, progress: { value: dayDone, max: allVisits.length } },
  ];

  // Left to right is the order a visit moves through the day.
  const columns: BoardColumn[] = [
    { id: "up_next", title: "Up next", empty: "No more bookings" },
    { id: "waiting", title: "Waiting", empty: "No one waiting" },
    { id: "with_practitioner", title: `With ${t.practitioner}`, empty: "No one in progress" },
    { id: "done", title: "Done", empty: "None finished yet" },
  ];

  const shownHeader = visibleList(headerActions, layout.lists?.header);
  const shownTiles = visibleList(tiles, layout.lists?.overview);
  const shownColumns = visibleList(columns, layout.lists?.columns);

  const customizeLists: CustomizeList[] = [
    { id: "header", label: "Buttons", description: "Shown in this order; extras move to ⋯", items: headerActions.map(({ id, label, description }) => ({ id, label, description })) },
    { id: "overview", label: "Overview tiles", items: tiles.map(({ id, label }) => ({ id, label })) },
    { id: "columns", label: "Queue columns", items: columns.map(({ id, title }) => ({ id, label: title })) },
  ];
  const customizeOptions: CustomizeOption[] = [
    { id: "defaultView", kind: "choice", label: "Opens as", description: "What the queue shows first", choices: [{ value: "queue", label: "Board" }, { value: "lanes", label: `By ${t.practitioner}` }, { value: "timeline", label: "Timeline" }], defaultValue: "queue" },
    {
      id: "waitingLimit",
      kind: "choice",
      label: "Waiting limit",
      description: "Waiting turns amber when more people than this are waiting",
      choices: [{ value: "off", label: "No limit" }, ...["5", "8", "10", "15", "20"].map((value) => ({ value, label: `${value} people` }))],
      defaultValue: "off",
    },
    { id: "showOverview", kind: "switch", label: "Show overview", description: "The four numbers above the queue", defaultValue: false },
  ];
  const customizeEntry: ActionMenuEntry = { id: "customize", label: "Customize Today…", icon: <Settings2 aria-hidden="true" />, onSelect: open("customize") };

  function editColumns(change: (ids: string[], hidden: Set<string>) => { order: string[]; hidden: Set<string> }) {
    const stored = layout.lists?.columns;
    const ids = arrangeList(columns, stored).map((entry) => entry.item.id);
    const next = change(ids, new Set(stored?.hidden ?? []));
    update(withListLayout(layout, "columns", { order: next.order, hidden: [...next.hidden] }) satisfies PageLayout);
  }

  function columnMenu(column: BoardColumn, index: number): ActionMenuEntry[] {
    const shownIds = shownColumns.map((item) => item.id);
    // Swap with the shown neighbor, so hidden columns never swallow a click.
    const move = (direction: -1 | 1) => editColumns((ids, hidden) => {
      const neighbor = shownIds[index + direction];
      if (!neighbor) return { order: ids, hidden };
      const order = ids.filter((id) => id !== column.id);
      order.splice(order.indexOf(neighbor) + (direction === 1 ? 1 : 0), 0, column.id);
      return { order, hidden };
    });
    return [
      { id: "left", label: "Move left", icon: <ArrowLeft aria-hidden="true" />, disabled: index === 0, onSelect: () => move(-1) },
      { id: "right", label: "Move right", icon: <ArrowRight aria-hidden="true" />, disabled: index === shownColumns.length - 1, onSelect: () => move(1) },
      { id: "sep", kind: "separator" },
      { id: "hide", label: "Hide column", icon: <EyeOff aria-hidden="true" />, onSelect: () => editColumns((ids, hidden) => ({ order: ids, hidden: new Set(hidden).add(column.id) })) },
      { id: "customize", label: "Customize Today…", icon: <Settings2 aria-hidden="true" />, onSelect: open("customize") },
    ];
  }

  /** Who and which room, for the Call next toast. */
  function placeOf(appointment: Appointment) {
    const rooms = appointment.resourceIds.map((id) => catalog.resourceName(id)).filter(Boolean).join(", ");
    return [catalog.practitionerName(appointment.practitionerId), rooms].filter(Boolean).join(" · ");
  }

  const timelineEvents = visible.map((appointment) => appointmentEvent(appointment, {
    patientName: appointmentPatientName(appointment, patients, t),
    serviceName: catalog.serviceName(appointment.serviceId),
    practitionerName: catalog.practitionerName(appointment.practitionerId),
    roomName: appointment.resourceIds.map((id) => catalog.resourceName(id)).filter(Boolean).join(", "),
  }));
  const timelineLanes = practitionerLanes(catalog.practitioners.filter((person) => (!practitionerIds.length || practitionerIds.includes(person.id)) && visible.some((appointment) => appointment.practitionerId === person.id)), dayKey, scheduleHours, clockIso);

  const filters: FilterGroup[] = [
    {
      id: "practitioner",
      label: t.Practitioner,
      icon: <Stethoscope aria-hidden="true" />,
      selected: practitionerIds,
      onChange: setPractitionerIds,
      choices: catalog.practitioners
        .filter((person) => allVisits.some((appointment) => appointment.practitionerId === person.id))
        .map((person) => ({ value: person.id, label: person.name, count: countWhere("practitioner", (appointment) => appointment.practitionerId === person.id) })),
    },
    {
      id: "service",
      label: "Service",
      icon: <CalendarClock aria-hidden="true" />,
      selected: serviceIds,
      onChange: setServiceIds,
      choices: catalog.services
        .filter((service) => allVisits.some((appointment) => appointment.serviceId === service.id))
        .map((service) => ({ value: service.id, label: service.name, count: countWhere("service", (appointment) => appointment.serviceId === service.id) })),
    },
    {
      id: "room",
      label: t.Resource,
      icon: <LayoutGrid aria-hidden="true" />,
      selected: roomIds,
      onChange: setRoomIds,
      choices: catalog.resources
        .filter((room) => allVisits.some((appointment) => appointment.resourceIds.includes(room.id)))
        .map((room) => ({ value: room.id, label: room.name, count: countWhere("room", (appointment) => appointment.resourceIds.includes(room.id)) })),
    },
    {
      id: "flag",
      label: "Flags",
      icon: <Flag aria-hidden="true" />,
      selected: flagIds,
      onChange: setFlagIds,
      choices: flagChoices.map(({ id, label, Icon }) => ({ value: id, label, icon: <Icon />, count: countWhere("flag", (appointment) => Boolean(flagsOf.get(appointment.id)?.has(id))) })),
    },
  ];
  const viewChoices: ViewChoice<View>[] = [
    { value: "queue", label: "Board", icon: <Columns3 aria-hidden="true" /> },
    { value: "lanes", label: `By ${t.practitioner}`, icon: <Rows3 aria-hidden="true" /> },
    { value: "timeline", label: "Timeline", icon: <GanttChart aria-hidden="true" /> },
  ];
  function clearFilters() {
    setSearch("");
    setPractitionerIds([]);
    setServiceIds([]);
    setRoomIds([]);
    setFlagIds([]);
  }

  const boardLanes = view === "lanes"
    ? catalog.practitioners
      .filter((person) => !practitionerIds.length || practitionerIds.includes(person.id))
      .map((person) => ({ id: person.id, name: person.name, image: person.photoUrl }))
    : undefined;

  const handlersFor = (appointment: Appointment): VisitHandlers => ({
    onStep: canMove ? (step) => void runStep(appointment, step, appointmentPatientName(appointment, patients, t)) : undefined,
    onQueue: canQueue ? (action) => void runQueue(appointment, action) : undefined,
    onMessage: canQueue ? (kind, delayMinutes) => void runMessage(appointment, kind, delayMinutes) : undefined,
    onPay: canPay ? () => setPayingId(appointment.id) : undefined,
    onPhoneLink: canQueue && database && appointment.queue ? () => setLinkTicket(appointment.queue ?? null) : undefined,
  });

  // "/" searches, "C" adds a walk-in and "?" lists the shortcuts, from anywhere on the page.
  const canWalkIn = useRef(canQueue);
  // A walk-in is a New appointment with "Walk-in" chosen: checked in now with the next free person.
  const openWalkIn = useRef(() => openNewVisit({ source: "walk_in" }));
  useEffect(() => {
    canWalkIn.current = canQueue;
    openWalkIn.current = () => openNewVisit({ source: "walk_in" });
  }, [canQueue, openNewVisit]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "?") {
        event.preventDefault();
        setPanel("keys");
      } else if ((event.key === "c" || event.key === "C") && canWalkIn.current && !document.querySelector("[aria-roledescription='Draggable card'][aria-pressed='true']")) {
        event.preventDefault();
        openWalkIn.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const serviceCounts = [...allVisits.reduce((counts, appointment) => counts.set(appointment.serviceId, (counts.get(appointment.serviceId) ?? 0) + 1), new Map<string, number>())]
    .map(([id, count]) => ({ id, name: catalog.serviceName(id) || "Other", count }))
    .sort((a, b) => b.count - a.count);

  // While the page is arriving, the overview numbers and the queue columns wait for the blocks above them. Once it has
  // settled, a view switch or a newly shown overview plays its own short entrance straight away.
  const [arriving, setArriving] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setArriving(false), 1200);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <WorkspacePage
      fit="desktop"
      // Part by part, like the customer pages: the header, the tips, the overview and the queue settle in one after
      // another. Backwards fill only, so nothing is left transformed once they land (the board measures cards to drag).
      className={cn(
        "*:motion-safe:fade-in-0 *:motion-safe:slide-in-from-bottom-1 *:motion-safe:animate-in *:motion-safe:fill-mode-backwards *:motion-safe:duration-500 *:motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
        "[&>*:nth-child(2)]:motion-safe:[--tw-animation-delay:70ms] [&>*:nth-child(3)]:motion-safe:[--tw-animation-delay:140ms] [&>*:nth-child(4)]:motion-safe:[--tw-animation-delay:210ms] [&>*:nth-child(n+5)]:motion-safe:[--tw-animation-delay:280ms]",
        arriving && "[--queue-offset:300ms] [--tiles-offset:200ms]",
      )}
      title={<span id="queue-title">{t.Customer} queue</span>}
      titleAddon={
        <TodayTracker
          counts={[
            { id: "booked", label: "Booked", value: allVisits.length },
            { id: "waiting", label: "Waiting", value: dayWaiting.length, attention: longestWait >= 15 },
            { id: "with", label: "Serving", value: allVisits.length - dayUpNext.length - dayWaiting.length - dayDone },
            { id: "done", label: "Done", value: dayDone },
          ]}
          note={[dayUpNext.length ? `${dayUpNext.length} still to arrive` : "", longestWait ? `longest wait ${longestWait} min` : ""].filter(Boolean).join(" · ") || undefined}
          services={serviceCounts}
          serviceLabel={t.service}
        />
      }
      bar={shownHeader}
      menu={[...moreMenu, customizeEntry]}
    >
      <OnboardingChecklist />

      {showOverview && shownTiles.length ? <Overview progressLabel={`${t.Visits} completed today`} items={shownTiles} /> : null}

      <WorkspaceFrame
        flush
        className="max-lg:min-h-[36rem]"
        panelClassName="overflow-hidden"
        start={<QueueFilterBar part="start" search={search} onSearch={setSearch} searchLabel={`Search today's ${t.customers}`} placeholder={`Name, phone or token`} filters={filters} onClear={clearFilters} view={view} views={viewChoices} onView={setView} searchRef={searchRef} />}
        end={<QueueFilterBar part="end" search={search} onSearch={setSearch} searchLabel={`Search today's ${t.customers}`} placeholder={`Name, phone or token`} filters={filters} onClear={clearFilters} view={view} views={viewChoices} onView={setView} searchRef={searchRef} />}
      >
        <section aria-labelledby="queue-title" className="flex min-h-0 min-w-0 flex-1 flex-col">
        {error ? <p role="alert" className="px-4 pt-3 text-sm text-destructive-foreground">{error}</p> : null}

        {view === "timeline" ? (
          <div className="flex h-[32rem] min-h-0 flex-col overflow-hidden lg:h-auto lg:flex-1">
            <DayTimeline dateKey={dayKey} events={timelineEvents} lanes={timelineLanes} label="Today's timeline" onOpenVisit={(id) => router.push(`/appointments/${id}?from=dashboard`)} />
          </div>
        ) : !allVisits.length ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon"><CalendarClock aria-hidden="true" /></EmptyMedia>
              <EmptyDescription>No {t.visits} are booked for today. New bookings will appear here as {t.customers} book or staff add them.</EmptyDescription>
            </EmptyHeader>
            <Button size="sm" onClick={() => openNewVisit()}><Plus aria-hidden="true" />New {t.appointment}</Button>
          </Empty>
        ) : !shownColumns.length ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon"><EyeOff aria-hidden="true" /></EmptyMedia>
              <EmptyDescription>Every queue column is hidden.</EmptyDescription>
            </EmptyHeader>
            <Button size="sm" variant="outline" onClick={open("customize")}><Settings2 aria-hidden="true" />Customize Today</Button>
          </Empty>
        ) : (
          <QueueBoard
            columns={shownColumns}
            visits={visible}
            lanes={boardLanes}
            timings={timings}
            clockIso={clockIso}
            t={t}
            currency={catalog.clinic.currency}
            nameOf={(appointment) => appointmentPatientName(appointment, patients, t)}
            serviceName={catalog.serviceName}
            person={(id) => {
              const person = catalog.getPractitioner(id);
              return person ? { name: person.name, image: person.photoUrl } : undefined;
            }}
            roomsOf={(appointment) => appointment.resourceIds.map((id) => catalog.resourceName(id)).filter(Boolean).join(", ")}
            canDrag={Boolean(canMove)}
            busyId={busyId}
            handlersFor={handlersFor}
            onMove={(appointment, step) => runStep(appointment, step, appointmentPatientName(appointment, patients, t))}
            columnMenu={canEdit ? columnMenu : undefined}
            waitingLimit={waitingLimit}
            onAddWalkIn={canQueue ? () => openNewVisit({ source: "walk_in" }) : undefined}
            onNewVisit={() => openNewVisit()}
          />
        )}
        </section>
      </WorkspaceFrame>

      <Dialog {...panelProps("keys")}>
        <DialogPopup className="sm:max-w-sm" bottomStickOnMobile>
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>Work the queue without the mouse.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <dl className="flex flex-col gap-2 text-sm">
              {shortcuts.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-4">
                  <dt>{item.label}</dt>
                  <dd className="flex gap-1">{item.keys.map((key) => <Kbd key={key}>{key}</Kbd>)}</dd>
                </div>
              ))}
            </dl>
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <HeardFromPanel {...panelProps("heard")} appointments={appointments} nowIso={clockIso} />
      <HandoverPanel {...panelProps("handover")} handover={handover} clockIso={clockIso} shared={database} clinical={clinical} />

      <CustomizeSheet
        {...panelProps("customize")}
        title="Customize Today"
        lists={customizeLists}
        options={customizeOptions}
        layout={layout}
        onChange={update}
        canEdit={canEdit}
      />

      {canCloseDay ? <DayEndDialog {...panelProps("dayend")} /> : null}
      {canQueue && database ? <ScreenLinkDialog {...panelProps("screen")} /> : null}
      {canQueue && database ? <DoorLinkDialog {...panelProps("door")} /> : null}
      {canQueue && database ? <CloseQueueDialog {...panelProps("closequeue")} /> : null}
      <PhoneLinkDialog ticketId={linkTicket?.ticketId ?? null} number={linkTicket?.number} onOpenChange={(open) => { if (!open) setLinkTicket(null); }} />
      <RunningLateDialog {...panelProps("late")} practitionerId={practitionerFilter || undefined} />
      <PaymentsDialog
        appointmentId={payingId}
        name={payingAppointment ? appointmentPatientName(payingAppointment, patients, t) : ""}
        canRefund={access.can("payments.refund")}
        onOpenChange={(open) => { if (!open) setPayingId(null); }}
      />
      <UrgentDialog
        number={urgentFor?.queue?.number ?? null}
        clinical={clinical}
        onCancel={() => setUrgentFor(null)}
        onConfirm={(reason) => {
          const target = urgentFor;
          setUrgentFor(null);
          if (target) void runQueue(target, "urgent", reason);
        }}
      />
    </WorkspacePage>
  );
}
