"use client";

import {
  AlarmClock,
  ArrowRight,
  CalendarClock,
  Clock3,
  EyeOff,
  FileWarning,
  Flag,
  Footprints,
  Hourglass,
  IndianRupee,
  LogOut,
  Megaphone,
  MessageSquare,
  PhoneCall,
  Repeat2,
  SkipForward,
  Smartphone,
  Timer,
  type LucideIcon,
} from "lucide-react";

import type { ActionMenuEntry } from "@/components/action-bar";
import type { Appointment } from "@/lib/domain";
import { formatMoney, visitBalance } from "@/lib/money";
import { delayOptions, quickMessageLabel, type QuickMessageKind } from "@/lib/quick-messages";
import type { TermWords } from "@/lib/terminology";

import { appointmentTime } from "./clinic-format";
import { lateLabel, waitingMinutes } from "./clinic-today";
import type { QueueAction } from "./preview-appointments";

/** Where a visit is in the business right now. Left to right is the order a visit moves through the day. */
export type Stage = "up_next" | "waiting" | "with_practitioner" | "done";

export const stageOrder: Stage[] = ["up_next", "waiting", "with_practitioner", "done"];

export const stageDot: Record<Stage, string> = { waiting: "bg-warning", with_practitioner: "bg-info", up_next: "bg-primary", done: "bg-success" };

export type Timings = Record<string, { checkedInAt?: string; startedAt?: string } | undefined>;

export function stageOf(appointment: Appointment, timings: Timings): Stage {
  if (appointment.status === "completed") return "done";
  if (appointment.status === "checked_in") return timings[appointment.id]?.startedAt ? "with_practitioner" : "waiting";
  return "up_next";
}

/** A step a visit can save in one tap. */
export type QuickStep = "checkin" | "start" | "complete" | "no_show" | "left";

/**
 * Whether a visit may move from one column to another by dragging, and the step that saves it.
 * Visits only move one column forward at a time, the same order the front desk works in.
 */
export function moveRule(appointment: Appointment, from: Stage, to: Stage, t: Pick<TermWords, "visit">): { step: QuickStep } | { reason: string } | null {
  if (from === to) return null;
  if (stageOrder.indexOf(to) < stageOrder.indexOf(from)) return { reason: `${capitalize(t.visit)}s only move forward. Open it to undo a step.` };
  if (stageOrder.indexOf(to) - stageOrder.indexOf(from) > 1) return { reason: "Move it one column at a time." };
  if (from === "up_next") return appointment.status === "booked" ? { step: "checkin" } : { reason: appointment.status === "pending_payment" ? "Waiting for payment first." : "Approve the booking first." };
  if (from === "waiting") return { step: "start" };
  return { step: "complete" };
}

function capitalize(word: string) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** What the filter row can narrow the board to, besides who and what. */
export type FlagId = "urgent" | "called" | "long_wait" | "late" | "form" | "request" | "walk_in" | "due";

export interface VisitFlag {
  id: FlagId | "wait" | "since";
  /** Full words, for the details panel and screen readers. */
  label: string;
  /** What the card has room for. */
  short: string;
  tone: "error" | "warning" | "info" | "muted";
  Icon: LucideIcon;
}

const formLabel: Record<string, string> = { not_assigned: "Form not assigned", not_started: "Form not started", in_progress: "Form in progress" };

/** Everything worth a glance on a card, problems first. The column already says the stage. */
export function visitFlags(stage: Stage, appointment: Appointment, timing: Timings[string], clockIso: string, currency?: string): VisitFlag[] {
  const flags: VisitFlag[] = [];
  const ticket = appointment.queue;
  if (stage === "waiting" && ticket?.urgent) flags.push({ id: "urgent", label: "Urgent", short: "Urgent", tone: "error", Icon: Flag });
  if (stage === "waiting" && ticket?.calledAt) {
    const times = ticket.callCount;
    flags.push({ id: "called", label: times > 1 ? `Called ${times} times` : `Called at ${appointmentTime(ticket.calledAt)}`, short: times > 1 ? `${times}×` : "Called", tone: "info", Icon: Megaphone });
  }
  if (stage === "waiting" && timing?.checkedInAt) {
    const minutes = waitingMinutes(timing.checkedInAt, clockIso);
    flags.push({ id: minutes >= 15 ? "long_wait" : "wait", label: `Waiting ${minutes} min`, short: `${minutes}m`, tone: minutes >= 15 ? "warning" : "muted", Icon: Hourglass });
  }
  if (stage === "with_practitioner" && timing?.startedAt) flags.push({ id: "since", label: `Started at ${appointmentTime(timing.startedAt)}`, short: appointmentTime(timing.startedAt), tone: "info", Icon: Clock3 });
  if (stage === "up_next") {
    if (appointment.status === "requested") flags.push({ id: "request", label: "Needs approval", short: "Request", tone: "warning", Icon: CalendarClock });
    if (appointment.status === "pending_payment") flags.push({ id: "due", label: "Awaiting payment", short: "Unpaid", tone: "warning", Icon: IndianRupee });
    const late = lateLabel(appointment.startsAt, clockIso);
    if (late) flags.push({ id: "late", label: late, short: late.replace("Late ", ""), tone: "warning", Icon: AlarmClock });
  }
  if ((stage === "up_next" || stage === "waiting") && appointment.formStatus !== "submitted") {
    flags.push({ id: "form", label: formLabel[appointment.formStatus] ?? "Form incomplete", short: "Form", tone: "warning", Icon: FileWarning });
  }
  if (appointment.bookingSource === "walk_in") flags.push({ id: "walk_in", label: "Walk-in", short: "Walk-in", tone: "muted", Icon: Footprints });
  if (stage === "done" && appointment.priceMinor) {
    const { dueMinor } = visitBalance(appointment.priceMinor, appointment.paidMinor, appointment.refundedMinor);
    if (dueMinor > 0) flags.push({ id: "due", label: `${formatMoney(dueMinor, currency)} to collect`, short: formatMoney(dueMinor, currency), tone: "warning", Icon: IndianRupee });
  }
  return flags;
}

export interface VisitHandlers {
  /** Saves a step right here. Without it, steps open the review page instead. */
  onStep?: (step: QuickStep) => void;
  /** Calls, skips or flags this customer's token. Only for customers who are waiting. */
  onQueue?: (action: QueueAction) => void;
  /** Sends this customer a quick message. Only before their visit starts. */
  onMessage?: (kind: QuickMessageKind, delayMinutes?: number) => void;
  /** Opens the payment dialog. Only with a database and the right to take payments. */
  onPay?: () => void;
  /** Shows a QR the customer scans to follow their place in the queue. Only with a database. */
  onPhoneLink?: () => void;
}

export interface VisitActions {
  /** The one next step, as words. */
  step: { label: string; action?: string };
  /** Set when that step saves right here. */
  quick?: QuickStep;
  /** "Collect ₹500" when a finished visit still owes money and payments can be taken. */
  collect?: string;
  /** The review page, with the next step preselected. */
  href: string;
  detailsHref: string;
  /** Call now or Call again, for a customer waiting with a token. */
  call?: { label: string; onSelect: () => void };
  /** Everything else, for ⋯. */
  menu: ActionMenuEntry[];
}

/** The next step for a visit and everything else staff can do with it. */
export function visitActions(appointment: Appointment, stage: Stage, clockIso: string, t: TermWords, handlers: VisitHandlers, currency?: string): VisitActions {
  const { onStep, onQueue, onMessage, onPay, onPhoneLink } = handlers;
  const steps: Record<Stage, { label: string; action?: string }> = {
    up_next: { label: "Check in", action: "checkin" },
    waiting: { label: `Start ${t.visit}`, action: "start" },
    with_practitioner: { label: `Finish ${t.visit}`, action: "complete" },
    done: { label: `Open ${t.visit}` },
  };
  const step = appointment.status === "requested" ? { label: "Review request" } : appointment.status === "pending_payment" ? { label: `Open ${t.visit}` } : steps[stage];
  const detailsHref = `/appointments/${appointment.id}?from=dashboard`;
  const href = `${detailsHref}${step.action ? `&action=${step.action}` : ""}`;
  const quick = onStep && step.action ? (step.action as QuickStep) : undefined;
  const canNoShow = appointment.status === "booked" && Date.parse(clockIso) >= Date.parse(appointment.startsAt);
  const ticket = stage === "waiting" ? appointment.queue : undefined;
  const call = ticket && onQueue ? { label: ticket.calledAt ? "Call again" : "Call now", onSelect: () => onQueue("call_again") } : undefined;

  const queueMenu: ActionMenuEntry[] = ticket && onQueue ? [
    { id: "call", label: ticket.calledAt ? "Call again" : "Call now", icon: ticket.calledAt ? <Repeat2 aria-hidden="true" /> : <Megaphone aria-hidden="true" />, onSelect: () => onQueue("call_again") },
    ...(ticket.calledAt ? [{ id: "skip", label: "Skip for now", icon: <SkipForward aria-hidden="true" />, onSelect: () => onQueue("skip") }] : []),
    ticket.urgent
      ? { id: "not_urgent", label: "Remove urgent", icon: <Flag aria-hidden="true" />, onSelect: () => onQueue("not_urgent") }
      : { id: "urgent", label: "Mark urgent…", icon: <Flag aria-hidden="true" />, onSelect: () => onQueue("urgent") },
    ...(onPhoneLink ? [{ id: "phone_link", label: "Phone link…", icon: <Smartphone aria-hidden="true" />, onSelect: onPhoneLink }] : []),
    { id: "queue-sep", kind: "separator" },
  ] : [];
  const canMessage = Boolean(onMessage) && (stage === "waiting" || stage === "up_next");
  const messageMenu: ActionMenuEntry[] = canMessage ? [{
    id: "message",
    kind: "submenu",
    label: "Send message",
    icon: <MessageSquare aria-hidden="true" />,
    items: [
      ...(stage === "waiting" ? [{ id: "your_turn", label: quickMessageLabel("your_turn"), icon: <Megaphone aria-hidden="true" />, onSelect: () => onMessage?.("your_turn") }] : []),
      {
        id: "running_late",
        kind: "submenu",
        label: quickMessageLabel("running_late"),
        icon: <Timer aria-hidden="true" />,
        items: delayOptions.map((minutes) => ({ id: `late-${minutes}`, label: `About ${minutes} min`, onSelect: () => onMessage?.("running_late", minutes) })),
      },
      { id: "call_us", label: quickMessageLabel("call_us"), icon: <PhoneCall aria-hidden="true" />, onSelect: () => onMessage?.("call_us") },
    ],
  }, { id: "message-sep", kind: "separator" }] : [];
  const money = onPay && appointment.status !== "cancelled" ? visitBalance(appointment.priceMinor, appointment.paidMinor, appointment.refundedMinor) : undefined;
  const collect = stage === "done" && money && money.dueMinor > 0 ? `Collect ${formatMoney(money.dueMinor, currency)}` : undefined;
  const payMenu: ActionMenuEntry[] = money ? [
    { id: "pay", label: money.dueMinor > 0 || money.state === "unpriced" ? "Take payment…" : "Payments…", icon: <IndianRupee aria-hidden="true" />, onSelect: () => onPay?.() },
    { id: "pay-sep", kind: "separator" },
  ] : [];
  const menu: ActionMenuEntry[] = [
    ...queueMenu,
    ...messageMenu,
    ...payMenu,
    { id: "open", label: `Open ${t.visit}`, icon: <ArrowRight aria-hidden="true" />, href: detailsHref },
    ...(onStep && ticket ? [{ id: "left", label: "Left without being seen", icon: <LogOut aria-hidden="true" />, destructive: true, onSelect: () => onStep("left") }] : []),
    ...(onStep && canNoShow ? [{ id: "no_show", label: "Mark no-show", icon: <EyeOff aria-hidden="true" />, destructive: true, onSelect: () => onStep("no_show") }] : []),
  ];
  return { step, quick, collect, href, detailsHref, call, menu };
}

/** Waiting customers in the order they will be seen: called now, then the order Call next picks. */
export function queueOrder(waiting: Appointment[], clockIso: string): Appointment[] {
  const due = (item: Appointment) => item.bookingSource !== "walk_in" && Date.parse(item.startsAt) <= Date.parse(clockIso);
  const rank = (item: Appointment) => [
    item.queue?.calledAt ? 0 : 1,
    item.queue?.urgent ? 0 : 1,
    item.queue?.skippedAt ? 1 : 0,
    due(item) ? 0 : 1,
    item.queue?.number ?? Number.MAX_SAFE_INTEGER,
  ];
  return [...waiting].sort((first, second) => {
    const a = rank(first);
    const b = rank(second);
    return a.reduce((result, value, index) => result || value - b[index]!, 0);
  });
}
