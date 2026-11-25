/**
 * The workflow engine: keeps `scheduled_messages` equal to what the booking's workflows say should be sent.
 * It runs inside the same transaction as the booking change, so a reminder can never outlive the booking it
 * was for. Planning twice changes nothing. Nothing is sent here: the worker's sweep does that.
 * No "server-only": the worker's reconcile job calls it too.
 */
import { sql, type SQL } from "drizzle-orm";

import { DEFAULT_QUIET_END_MINUTE, DEFAULT_QUIET_START_MINUTE, type WorkflowTrigger } from "../../lib/workflow-contracts";
import { planVideoRoom } from "../video/plan";
import { asDate, asNumber, asString, type Row, type Runner } from "./runner";
import { eventTriggerFor, planMessages, type PlanAppointment, type PlanEvent, type PlannedMessage, type PlanWorkflow } from "./triggers";

const ENDED_STATUSES = new Set(["cancelled", "no_show", "entered_in_error", "declined", "expired"]);

interface WorkflowRow extends Row {
  id: string;
  trigger: WorkflowTrigger;
  offset_minutes: number;
  filters: unknown;
  step_id: string;
  position: number;
  wait_minutes: number;
  ignore_quiet_hours: boolean;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Active workflows with their steps, as the planner reads them. */
export async function loadPlanWorkflows(run: Runner, tenantId: string): Promise<PlanWorkflow[]> {
  const rows = await run(sql`
    select workflow.id, workflow.trigger, workflow.offset_minutes, workflow.filters,
      step.id as step_id, step.position, step.wait_minutes, step.ignore_quiet_hours
    from workflows as workflow
    join workflow_steps as step on step.tenant_id = workflow.tenant_id and step.workflow_id = workflow.id
    where workflow.tenant_id = ${tenantId} and workflow.active
    order by workflow.id, step.position
  `) as WorkflowRow[];
  const byId = new Map<string, PlanWorkflow>();
  for (const row of rows) {
    const filters = (row.filters && typeof row.filters === "object" ? row.filters : {}) as Record<string, unknown>;
    let workflow = byId.get(asString(row.id));
    if (!workflow) {
      workflow = {
        id: asString(row.id),
        trigger: row.trigger,
        offsetMinutes: asNumber(row.offset_minutes),
        filters: {
          serviceIds: stringList(filters.serviceIds),
          locationIds: stringList(filters.locationIds),
          practitionerIds: stringList(filters.practitionerIds),
          bookingSources: stringList(filters.bookingSources),
          deliveryModes: stringList(filters.deliveryModes).filter((mode): mode is "in_person" | "video" | "phone" => mode === "in_person" || mode === "video" || mode === "phone"),
        },
        steps: [],
      };
      byId.set(workflow.id, workflow);
    }
    workflow.steps.push({
      id: asString(row.step_id),
      position: asNumber(row.position),
      waitMinutes: asNumber(row.wait_minutes),
      ignoreQuietHours: Boolean(row.ignore_quiet_hours),
    });
  }
  return [...byId.values()];
}

export async function loadQuietHours(run: Runner, tenantId: string): Promise<{ startMinute: number; endMinute: number }> {
  const [row] = await run(sql`select quiet_start_minute, quiet_end_minute from workflow_settings where tenant_id = ${tenantId}`);
  return row
    ? { startMinute: asNumber(row.quiet_start_minute), endMinute: asNumber(row.quiet_end_minute) }
    : { startMinute: DEFAULT_QUIET_START_MINUTE, endMinute: DEFAULT_QUIET_END_MINUTE };
}

async function loadAppointment(run: Runner, tenantId: string, appointmentId: string): Promise<PlanAppointment | null> {
  const [row] = await run(sql`
    select appointment.id, appointment.version, appointment.status, appointment.form_status,
      appointment.starts_at, appointment.ends_at, appointment.completed_at, appointment.location_id, appointment.practitioner_id,
      appointment.service_id, appointment.booking_source, appointment.delivery_mode,
      appointment.series_id is not null as in_series, appointment.is_sample,
      coalesce(location.timezone, tenant.timezone) as time_zone
    from appointments as appointment
    join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    join tenants as tenant on tenant.id = appointment.tenant_id
    where appointment.tenant_id = ${tenantId} and appointment.id = ${appointmentId}
  `);
  // A sample appointment from onboarding (feature 11) is never planned for: it is read as if it did not exist, so no reminder, follow-up or review request is ever made for a customer who is not real.
  if (!row || row.is_sample === true) return null;
  return {
    id: asString(row.id),
    version: asNumber(row.version),
    status: asString(row.status),
    formStatus: asString(row.form_status),
    startsAt: asDate(row.starts_at),
    endsAt: asDate(row.ends_at),
    completedAt: row.completed_at ? asDate(row.completed_at) : null,
    locationId: asString(row.location_id),
    practitionerId: asString(row.practitioner_id),
    serviceId: asString(row.service_id),
    bookingSource: asString(row.booking_source),
    deliveryMode: asString(row.delivery_mode) || "in_person",
    timeZone: asString(row.time_zone) || "UTC",
    inSeries: row.in_series === true,
  };
}

export interface PlanResult {
  planned: number;
  cancelled: number;
}

/**
 * Brings one booking's waiting messages up to date:
 * - timed messages that no longer fit (moved, cancelled, form received, workflow edited) are cancelled;
 * - the messages that fit now are added, or revived if the booking moved away and back;
 * - a booking that ended (cancelled, no-show) keeps only what its own end event sends.
 * `event` is the change that just happened, so event triggers (booked, cancelled…) can fire once for it.
 */
export async function planAppointment(
  run: Runner,
  tenantId: string,
  appointmentId: string,
  event?: PlanEvent,
  now: Date = new Date(),
): Promise<PlanResult> {
  const appointment = await loadAppointment(run, tenantId, appointmentId);
  if (!appointment) return { planned: 0, cancelled: 0 };
  const [workflows, quiet] = await Promise.all([loadPlanWorkflows(run, tenantId), loadQuietHours(run, tenantId)]);
  const [settings] = await run(sql`select presets_applied_at from workflow_settings where tenant_id = ${tenantId}`);
  const settled = await run(sql`
    select distinct step_id from scheduled_messages
    where tenant_id = ${tenantId} and appointment_id = ${appointmentId} and status in ('sent', 'queued', 'skipped', 'failed')
  `);
  const desired = planMessages(appointment, workflows, quiet, now, event, {
    followUpsSince: settings?.presets_applied_at ? asDate(settings.presets_applied_at) : null,
    settledSteps: new Set(settled.map((row) => asString(row.step_id))),
  });

  const timed = desired.filter((message) => message.slotKey.startsWith("t:"));
  const keep: SQL = timed.length === 0
    ? sql`true`
    : sql`(step_id, slot_key) not in (${sql.join(timed.map((message) => sql`(${message.stepId}, ${message.slotKey})`), sql`, `)})`;
  const superseded = await run(sql`
    update scheduled_messages set status = 'cancelled', reason = 'superseded', updated_at = now()
    where tenant_id = ${tenantId} and appointment_id = ${appointmentId}
      and status = 'pending' and slot_key like 't:%' and ${keep}
    returning id
  `);

  let cancelled = superseded.length;
  if (ENDED_STATUSES.has(appointment.status)) {
    // Whatever was waiting for a visit that will not happen stays unsent, except what this very ending sends.
    const own = eventTriggerFor(`appointment.status.${appointment.status}`, appointment.status) ?? "none";
    const ended = await run(sql`
      update scheduled_messages as message set status = 'cancelled', reason = 'booking_ended', updated_at = now()
      from workflow_steps as step
      join workflows as workflow on workflow.tenant_id = step.tenant_id and workflow.id = step.workflow_id
      where step.tenant_id = message.tenant_id and step.id = message.step_id
        and message.tenant_id = ${tenantId} and message.appointment_id = ${appointmentId}
        and message.status = 'pending' and workflow.trigger <> ${own}
      returning message.id
    `);
    cancelled += ended.length;
  }

  await insertPlanned(run, tenantId, appointment, desired);
  // A video visit also needs its room made (or closed) in step with the booking.
  await planVideoRoom(run, tenantId, appointment.id, now);
  return { planned: desired.length, cancelled };
}

async function insertPlanned(run: Runner, tenantId: string, appointment: PlanAppointment, desired: PlannedMessage[]): Promise<void> {
  if (desired.length === 0) return;
  const values = desired.map((message) =>
    sql`(${tenantId}, ${appointment.id}, ${message.workflowId}, ${message.stepId}, ${message.slotKey}, ${appointment.version}, ${message.sendAt.toISOString()}::timestamptz)`);
  await run(sql`
    insert into scheduled_messages (tenant_id, appointment_id, workflow_id, step_id, slot_key, appointment_version, send_at)
    values ${sql.join(values, sql`, `)}
    on conflict (tenant_id, appointment_id, step_id, slot_key) do update
      set send_at = excluded.send_at, appointment_version = excluded.appointment_version,
        status = 'pending', reason = null, updated_at = now()
      where scheduled_messages.status in ('pending', 'cancelled')
  `);
}

/** Re-plans every upcoming or recently finished booking, a page at a time. Used after workflows are edited. */
export async function replanTenant(run: Runner, tenantId: string, now: Date = new Date(), pageSize = 200): Promise<number> {
  let last = "";
  let total = 0;
  for (;;) {
    const page = await run(sql`
      select id from appointments
      where tenant_id = ${tenantId} and id > ${last}
        and ((status in ('requested', 'booked') and starts_at > ${now.toISOString()}::timestamptz)
          or (status = 'completed' and ends_at > ${new Date(now.getTime() - 7 * 86_400_000).toISOString()}::timestamptz))
      order by id limit ${pageSize}
    `);
    if (page.length === 0) return total;
    for (const row of page) await planAppointment(run, tenantId, asString(row.id), undefined, now);
    total += page.length;
    last = asString(page[page.length - 1]?.id);
  }
}
