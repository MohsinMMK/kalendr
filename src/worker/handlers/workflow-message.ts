import { z } from "zod";

import { templateKeysFor, type WorkflowChannelKey, type WorkflowTemplateKey, type WorkflowTrigger } from "../../lib/workflow-contracts";
import { appOrigin } from "../../server/env";
import { openManageToken } from "../../server/messaging/sealed-link";
import { ensureRatingLink } from "../../server/rating-requests";
import { postgresRunner } from "../../server/workflows/runner";
import { afterQuietHours, isQuietMinute, localMinuteOfDay } from "../../server/workflows/quiet-hours";
import { renderMessage, sampleValues, type RenderContext } from "../../server/workflows/render";
import { fillTemplate } from "../../lib/workflow-contracts";
import type { HandlerDependencies } from "./appointment-message";
import type { EventHandler, HandlerOutcome, OutboxEvent, TenantDb } from "./types";

/**
 * Sends one message a workflow planned (`workflow.message`) and runs a workflow's "send me a test"
 * (`workflow.test`). The sweep only hands a due message here; this re-reads the booking and decides.
 * Nothing is logged: not the recipient, the name or the text. Codes say why a message was skipped.
 */

const messagePayload = z.object({ scheduledMessageId: z.string().min(1) });
const testPayload = z.object({ workflowId: z.string().min(1), userId: z.string().min(1) });

/** The event type each approved message goes by, which the WhatsApp and SMS adapters turn into a template. */
export const APPROVED_MESSAGE_EVENT: Record<WorkflowTemplateKey, string> = {
  reminder: "appointment.reminder",
  booking_confirmed: "appointment.created",
  rescheduled: "appointment.reschedule",
  cancelled: "appointment.cancel",
  review_request: "appointment.review_request",
};

const QUIET_EXEMPT: ReadonlySet<string> = new Set(["booked", "requested", "rescheduled", "cancelled"]);
const LIVE: ReadonlySet<string> = new Set(["requested", "booked"]);

interface MessageRow {
  id: string;
  status: string;
  appointment_id: string;
  step_id: string;
  channel: WorkflowChannelKey;
  subject: string;
  body: string;
  template_key: WorkflowTemplateKey | null;
  whatsapp_enabled: boolean;
  sms_enabled: boolean;
  ignore_quiet_hours: boolean;
  skip_if_confirmed: boolean;
  trigger: WorkflowTrigger;
  appointment_status: string;
  confirmation_status: string;
  form_status: string;
  starts_at: Date;
  manage_token_ciphertext: string | null;
  patient_id: string;
  first_name: string;
  last_name: string;
  messaging_consent: boolean;
  service_name: string;
  practitioner_name: string;
  location_name: string;
  location_address: string;
  location_city: string;
  time_zone: string;
  business_name: string;
  business_phone: string | null;
  delivery_mode: string | null;
  hide_location_until_confirmed: boolean;
}

async function loadMessage(tenantDb: TenantDb, tenantId: string, id: string): Promise<MessageRow | undefined> {
  const rows = await tenantDb`
    select message.id, message.status, message.appointment_id, message.step_id,
      step.channel, step.subject, step.body, step.template_key, step.ignore_quiet_hours, step.skip_if_confirmed,
      coalesce(channel_settings.whatsapp_enabled, true) as whatsapp_enabled,
      coalesce(channel_settings.sms_enabled, true) as sms_enabled,
      workflow.trigger,
      appointment.status as appointment_status, appointment.confirmation_status, appointment.form_status,
      appointment.starts_at, appointment.manage_token_ciphertext, appointment.delivery_mode,
      patient.id as patient_id, patient.first_name, patient.last_name,
      patient.messaging_consent_at is not null as messaging_consent,
      service.name as service_name, practitioner.name as practitioner_name,
      location.name as location_name, location.address as location_address, location.city as location_city,
      coalesce(location.timezone, tenant.timezone) as time_zone,
      tenant.name as business_name, tenant.phone as business_phone, service.hide_location_until_confirmed
    from scheduled_messages as message
    join workflow_steps as step on step.tenant_id = message.tenant_id and step.id = message.step_id
    join workflows as workflow on workflow.tenant_id = step.tenant_id and workflow.id = step.workflow_id
    join appointments as appointment on appointment.tenant_id = message.tenant_id and appointment.id = message.appointment_id
    join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
    join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    join tenants as tenant on tenant.id = message.tenant_id
    left join tenant_channel_settings as channel_settings on channel_settings.tenant_id = message.tenant_id
    where message.tenant_id = ${tenantId} and message.id = ${id}
    for update of message
  `;
  return rows[0] as MessageRow | undefined;
}

/** Why a message that was due should not go after all, or null when it should. */
export function skipReason(row: Pick<MessageRow, "trigger" | "appointment_status" | "form_status" | "confirmation_status" | "skip_if_confirmed" | "starts_at">, now: Date): string | null {
  const status = row.appointment_status;
  switch (row.trigger) {
    case "before_start":
      if (!LIVE.has(status) || row.starts_at <= now) return "booking_changed";
      break;
    case "form_missing":
      if (!LIVE.has(status) || row.starts_at <= now) return "booking_changed";
      if (row.form_status !== "not_started" && row.form_status !== "in_progress") return "form_received";
      break;
    case "after_end":
      if (status !== "completed") return "booking_changed";
      break;
    case "booked":
      if (status !== "booked") return "booking_changed";
      break;
    case "requested":
      if (status !== "requested") return "booking_changed";
      break;
    case "rescheduled":
      if (!LIVE.has(status)) return "booking_changed";
      break;
    case "cancelled":
      // A declined or expired request ends the booking like a cancellation does (feature 41).
      if (status !== "cancelled" && status !== "declined" && status !== "expired") return "booking_changed";
      break;
    case "no_show":
      if (status !== "no_show") return "booking_changed";
      break;
    case "checked_in":
      if (status !== "checked_in") return "booking_changed";
      break;
  }
  if (row.skip_if_confirmed && row.confirmation_status === "confirmed") return "already_confirmed";
  return null;
}

export function workflowMessageHandler({ sink, now, origin }: HandlerDependencies): EventHandler {
  return async (tenantDb, event): Promise<HandlerOutcome> => {
    const payload = messagePayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const at = now();
    const row = await loadMessage(tenantDb, event.tenantId, payload.data.scheduledMessageId);
    // Gone, or already dealt with by an earlier attempt: nothing to do.
    // A failed row is tried again when staff press "Try again" on the Messages screen.
    if (!row || (row.status !== "queued" && row.status !== "failed")) return "delivered";

    const settle = async (status: "sent" | "skipped" | "failed", reason: string | null) => {
      await tenantDb`
        update scheduled_messages set status = ${status}, reason = ${reason},
          sent_at = ${status === "sent" ? at : null}, updated_at = now()
        where tenant_id = ${event.tenantId} and id = ${row.id}
      `;
      // The booking's "Reminder" badge on the staff screens follows its reminder messages.
      if (row.trigger === "before_start" && status !== "skipped") {
        await tenantDb`
          update appointments set reminder_status = ${status === "sent" ? "delivered" : "failed"}, updated_at = now()
          where tenant_id = ${event.tenantId} and id = ${row.appointment_id} and reminder_status in ('queued', 'failed', 'not_scheduled')
        `;
      }
    };

    const why = skipReason(row, at);
    if (why) { await settle("skipped", why); return "delivered"; }

    if (!row.ignore_quiet_hours && !QUIET_EXEMPT.has(row.trigger)) {
      const [quiet] = await tenantDb`select quiet_start_minute, quiet_end_minute from workflow_settings where tenant_id = ${event.tenantId}`;
      const start = Number(quiet?.quiet_start_minute ?? 1260);
      const end = Number(quiet?.quiet_end_minute ?? 480);
      if (isQuietMinute(localMinuteOfDay(at, row.time_zone), start, end)) {
        // Settings changed after the sweep, or the clock moved: wait for the quiet hours to end.
        await tenantDb`
          update scheduled_messages set status = 'pending', send_at = ${afterQuietHours(at, row.time_zone, start, end)}, updated_at = now()
          where tenant_id = ${event.tenantId} and id = ${row.id}
        `;
        return "delivered";
      }
    }
    if (row.channel !== "email") {
      // WhatsApp and text only go to customers who agreed to them, from a business that has the channel on, as an approved message.
      if (!row.messaging_consent) { await settle("skipped", "no_consent"); return "delivered"; }
      if (row.channel === "whatsapp" ? !row.whatsapp_enabled : !row.sms_enabled) { await settle("skipped", "channel_off"); return "delivered"; }
      if (!row.template_key || !templateKeysFor(row.channel).includes(row.template_key)) { await settle("skipped", "no_template"); return "delivered"; }
    }

    const base = origin ?? appOrigin();
    const token = openManageToken(event.tenantId, row.appointment_id, row.manage_token_ciphertext);
    // The one-tap rating link (feature 51): made only for a message that uses it, once per visit, at most once a month per customer.
    let ratingLink: string | null = null;
    if (row.channel === "email" && /\{rating_link\}/.test(`${row.subject}\n${row.body}`)) {
      const ask = await ensureRatingLink(postgresRunner(tenantDb), { tenantId: event.tenantId, appointmentId: row.appointment_id, now: at });
      if (!ask.ok) { await settle("skipped", `rating_${ask.reason}`); return "delivered"; }
      ratingLink = ask.link(base);
    }
    const hideLocation = row.hide_location_until_confirmed && row.appointment_status === "requested";
    const context: RenderContext = {
      customerFirstName: row.first_name,
      customerName: `${row.first_name} ${row.last_name}`.trim(),
      service: row.service_name,
      staffName: row.practitioner_name,
      startsAt: row.starts_at,
      timeZone: row.time_zone,
      // A request on a service that hides its address says nothing about it until it is approved (feature 41).
      locationName: hideLocation ? "" : row.location_name,
      locationAddress: hideLocation ? "" : [row.location_address, row.location_city].filter(Boolean).join(", "),
      businessName: row.business_name,
      businessPhone: row.business_phone,
      manageLink: token ? `${base}/manage/${encodeURIComponent(token)}` : null,
      joinLink: token && row.delivery_mode === "video" ? `${base}/visit/${encodeURIComponent(token)}` : null,
      cameraTestLink: token && row.delivery_mode === "video" ? `${base}/visit/${encodeURIComponent(token)}?test=1` : null,
      ratingLink,
    };
    const rendered = row.channel === "email"
      ? renderMessage({ subject: row.subject, body: row.body }, context)
      : { subject: "", body: "" };

    const outcome = await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: row.appointment_id,
      patientId: row.patient_id,
      channel: row.channel,
      message: {
        semanticKey: `local:workflow:${row.id}`,
        // Email carries our own words under a workflow key; the other channels name the approved message through the
        // event that maps to it, which is how their adapters pick the template.
        templateKey: row.channel === "email" || !row.template_key ? `workflow:${row.step_id}` : APPROVED_MESSAGE_EVENT[row.template_key],
        subject: rendered.subject,
        body: rendered.body,
        scheduledAt: at,
      },
    }, at);
    if (typeof outcome === "object") {
      if (outcome.outcome === "retry") return outcome;
      await settle("failed", outcome.code);
      return outcome;
    }
    if (outcome === "retry") return "retry";
    if (outcome === "dead") { await settle("failed", "provider_error"); return "dead"; }
    // The sink records "delivered" even for a message it chose not to send (no address, suppressed); read what it wrote.
    const [note] = await tenantDb`
      select status, failure_code from notifications
      where tenant_id = ${event.tenantId} and semantic_key in (${`local:workflow:${row.id}`}, ${`${row.channel}:${row.id}`})
      limit 1
    `;
    if (note?.status === "cancelled") await settle("skipped", String(note.failure_code ?? "not_sent"));
    else await settle("sent", null);
    return "delivered";
  };
}

/** "Send me a test": every step of a workflow, filled with sample details, to the staff member who asked. Email only for now. */
export function workflowTestHandler({ sink, now }: HandlerDependencies): EventHandler {
  return async (tenantDb: TenantDb, event: OutboxEvent): Promise<HandlerOutcome> => {
    const payload = testPayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const at = now();
    const [user] = await tenantDb`
      select auth_user.email from auth_users as auth_user
      join memberships as membership on membership.user_id = auth_user.id
      where membership.tenant_id = ${event.tenantId} and auth_user.id = ${payload.data.userId}
      limit 1
    `;
    const email = typeof user?.email === "string" ? user.email : null;
    if (!email) return { outcome: "dead", code: "no_destination" };
    const steps = await tenantDb`
      select step.id, step.position, step.channel, step.subject, step.body
      from workflow_steps as step
      where step.tenant_id = ${event.tenantId} and step.workflow_id = ${payload.data.workflowId}
      order by step.position
    `;
    for (const step of steps as unknown as { id: string; position: number; channel: WorkflowChannelKey; subject: string; body: string }[]) {
      // Other channels send to the customer's own number; a test never does. They join when their senders can take a test address.
      if (step.channel !== "email") continue;
      const outcome = await sink.deliver(tenantDb, {
        tenantId: event.tenantId,
        appointmentId: null,
        patientId: `staff:${payload.data.userId}`,
        channel: step.channel,
        testRecipientEmail: email,
        message: {
          semanticKey: `local:workflow:test:${event.id}:${step.position}`,
          templateKey: `workflow:${step.id}`,
          subject: `[Test] ${fillTemplate(step.subject, sampleValues)}`.slice(0, 200),
          body: fillTemplate(step.body, sampleValues),
          scheduledAt: at,
        },
      }, at);
      if (typeof outcome === "object") return outcome;
      if (outcome === "retry" || outcome === "dead") return outcome;
    }
    return "delivered";
  };
}

/** True once a business runs on workflows: its reminders and review requests come from them, so the fixed ones stand down. */
export async function runsOnWorkflows(tenantDb: TenantDb, tenantId: string): Promise<boolean> {
  const [row] = await tenantDb`select 1 as present from workflow_settings where tenant_id = ${tenantId} and presets_applied_at is not null`;
  return Boolean(row);
}

/** Wraps a fixed-message handler so it does nothing for a business that has moved to workflows. */
export function standDownForWorkflows(handler: EventHandler): EventHandler {
  return async (tenantDb, event) => (await runsOnWorkflows(tenantDb, event.tenantId)) ? "delivered" : handler(tenantDb, event);
}
