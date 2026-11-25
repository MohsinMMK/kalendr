/**
 * Which messages a booking should have waiting, as a pure function of the booking, the workflows and the clock.
 * The engine writes the result to the database; nothing here reads or writes anything.
 */
import type { WorkflowFilters, WorkflowTrigger } from "../../lib/workflow-contracts";
import { afterQuietHours } from "./quiet-hours";

export interface PlanAppointment {
  id: string;
  version: number;
  status: string;
  formStatus: string;
  startsAt: Date;
  endsAt: Date;
  /** When the visit was marked finished. A follow-up is for a visit finished after workflows were switched on. */
  completedAt: Date | null;
  locationId: string;
  practitionerId: string;
  serviceId: string;
  bookingSource: string;
  deliveryMode: string;
  /** The location's time zone, falling back to the business's. */
  timeZone: string;
  /** The visit belongs to a repeating series, whose one confirmation replaces the per-visit "booked" message (feature 17). */
  inSeries?: boolean;
}

export interface PlanStep {
  id: string;
  position: number;
  waitMinutes: number;
  ignoreQuietHours: boolean;
}

export interface PlanWorkflow {
  id: string;
  trigger: WorkflowTrigger;
  offsetMinutes: number;
  filters: Partial<WorkflowFilters>;
  steps: PlanStep[];
}

export interface PlanQuietHours {
  startMinute: number;
  endMinute: number;
}

export interface PlannedMessage {
  workflowId: string;
  stepId: string;
  slotKey: string;
  sendAt: Date;
  trigger: WorkflowTrigger;
}

/** The change that just happened to the booking, as the outbox names it. */
export interface PlanEvent {
  action: string;
  version: number;
}

const MINUTE = 60_000;
/** A follow-up planned for a visit that ended longer ago than this is not sent: it would arrive out of the blue. */
const STALE_FOLLOW_UP_MS = 7 * 24 * 60 * MINUTE;
/** Messages that answer something the customer just did are not held back for quiet hours. */
const QUIET_EXEMPT: ReadonlySet<WorkflowTrigger> = new Set(["booked", "requested", "rescheduled", "cancelled"]);
const LIVE_STATUSES: ReadonlySet<string> = new Set(["requested", "booked"]);

/** Which event trigger an outbox action stands for, or null when it is not one. */
export function eventTriggerFor(action: string, status: string): WorkflowTrigger | null {
  switch (action) {
    case "appointment.created": return status === "requested" ? "requested" : status === "booked" ? "booked" : null;
    case "appointment.status.booked": return "booked";
    case "appointment.status.requested": return "requested";
    case "appointment.reassigned":
    case "appointment.location_changed":
    case "appointment.reschedule":
    case "appointment.suggest": return "rescheduled";
    case "appointment.cancel":
    case "appointment.status.cancelled":
    case "appointment.status.declined":
    case "appointment.status.expired": return "cancelled";
    case "appointment.status.no_show": return "no_show";
    case "appointment.status.checked_in": return "checked_in";
    default: return null;
  }
}

export function matchesFilters(filters: Partial<WorkflowFilters>, appointment: PlanAppointment): boolean {
  const within = (allowed: string[] | undefined, value: string) => !allowed || allowed.length === 0 || allowed.includes(value);
  return within(filters.serviceIds, appointment.serviceId)
    && within(filters.locationIds, appointment.locationId)
    && within(filters.practitionerIds, appointment.practitionerId)
    && within(filters.bookingSources, appointment.bookingSource)
    && within(filters.deliveryModes, appointment.deliveryMode);
}

/**
 * Timed triggers describe themselves from the booking's own times, so they are planned on every change and
 * keyed by the moment. Event triggers fire once per change and are keyed by it.
 */
export interface PlanOptions {
  /** Follow-ups (after the visit) are only for visits finished at or after this time: when the business moved onto workflows. */
  followUpsSince?: Date | null;
  /** Steps that already sent, were handed to the worker or were skipped for this booking. A follow-up is sent once per step. */
  settledSteps?: ReadonlySet<string>;
}

export function planMessages(
  appointment: PlanAppointment,
  workflows: readonly PlanWorkflow[],
  quiet: PlanQuietHours,
  now: Date,
  event?: PlanEvent,
  options: PlanOptions = {},
): PlannedMessage[] {
  const planned: PlannedMessage[] = [];
  // A series is confirmed once, for all its visits together; its reminders and every later change still plan per visit.
  const firedTrigger = event && !(appointment.inSeries && event.action === "appointment.created") ? eventTriggerFor(event.action, appointment.status) : null;

  for (const workflow of workflows) {
    if (!matchesFilters(workflow.filters, appointment)) continue;
    const timed = timedBase(workflow, appointment, options);
    const fired = workflow.trigger === firedTrigger && event ? { at: now, key: `e:${event.action}:${event.version}` } : null;
    if (timed === null && fired === null) continue;

    let cumulative = 0;
    for (const step of [...workflow.steps].sort((a, b) => a.position - b.position)) {
      cumulative += step.waitMinutes;
      // A follow-up goes out once per booking and step, however the workflow is edited afterwards.
      if (workflow.trigger === "after_end" && options.settledSteps?.has(step.id)) continue;
      const raw = new Date((timed ?? fired!.at).getTime() + cumulative * MINUTE);
      if (timed !== null) {
        const sameDay = workflow.trigger === "after_end";
        if (!sameDay && raw <= now) continue;
        if (sameDay && now.getTime() - raw.getTime() > STALE_FOLLOW_UP_MS) continue;
      }
      const exempt = step.ignoreQuietHours || QUIET_EXEMPT.has(workflow.trigger);
      const sendAt = exempt ? raw : afterQuietHours(raw, appointment.timeZone, quiet.startMinute, quiet.endMinute);
      // A reminder pushed past the start by quiet hours would arrive late and is dropped.
      if ((workflow.trigger === "before_start" || workflow.trigger === "form_missing") && sendAt >= appointment.startsAt) continue;
      planned.push({
        workflowId: workflow.id,
        stepId: step.id,
        slotKey: timed !== null ? `t:${raw.getTime()}` : fired!.key,
        sendAt,
        trigger: workflow.trigger,
      });
    }
  }
  return planned;
}

/** The moment a timed trigger counts from, or null when the trigger is not timed or does not apply to this booking now. */
function timedBase(workflow: PlanWorkflow, appointment: PlanAppointment, options: PlanOptions): Date | null {
  switch (workflow.trigger) {
    case "before_start":
      return LIVE_STATUSES.has(appointment.status) ? new Date(appointment.startsAt.getTime() - workflow.offsetMinutes * MINUTE) : null;
    case "form_missing":
      return LIVE_STATUSES.has(appointment.status) && (appointment.formStatus === "not_started" || appointment.formStatus === "in_progress")
        ? new Date(appointment.startsAt.getTime() - workflow.offsetMinutes * MINUTE)
        : null;
    case "after_end":
      if (options.followUpsSince && appointment.completedAt && appointment.completedAt < options.followUpsSince) return null;
      return appointment.status === "completed" ? new Date(appointment.endsAt.getTime() + workflow.offsetMinutes * MINUTE) : null;
    default:
      return null;
  }
}
