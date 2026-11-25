import type { VideoProvider } from "../../server/video/provider";
import { channelTemplateFor, smsTemplateKeys } from "../../lib/channel-templates";
import { notificationChannel, type BookingOrigin, type ChannelAvailability, type NotificationChannel } from "../../lib/notification-routing";
import type { Channel } from "../../server/channels/types";
import type { MessageProvider } from "../../server/messaging/provider";
import type { MessageSink } from "../delivery";
import type { CalendarDeps } from "../calendar/common";
import type { PushSender } from "../push";
import type { WebhookDependencies } from "./webhook-deliver";
import { planCapture, type AppointmentSnapshot } from "../policy";
import { tenantWords } from "./words";
import type { EventHandler, HandlerOutcome, OutboxEvent, TenantDb } from "./types";

export interface HandlerDependencies {
  sink: MessageSink;
  now: () => Date;
  /** Sends web push (feature 32). Left out when push is not set up, and then push events finish without sending. */
  push?: PushSender;
  /** Calendar adapters and clock (feature 16). Defaults to the live adapters; tests pass fakes. */
  calendar?: CalendarDeps;
  /** Makes and closes video rooms. Null when video is turned off for this process. */
  video?: VideoProvider | null;
  /** Channels the worker can actually send on. Left out, every channel counts as available (tests, local capture). */
  available?: ChannelAvailability;
  /** Sends staff replies and the one-time STOP confirmation. */
  channels?: { whatsapp?: Channel };
  /** Public origin for links in replies, with no trailing slash. */
  origin?: string;
  /** Local capture and tests may send templates Meta has not approved yet. Production never does. */
  allowUnapprovedTemplates?: boolean;
  /** For messages that are not about a customer record, such as the booking code (feature 40). Absent when email is not set up. */
  email?: { provider: MessageProvider; fallbackReplyTo: string | null };
  /** Outgoing webhooks (feature 34): the sender and the retry policy. Defaults to the real sender and policy; tests pass fakes. */
  webhooks?: WebhookDependencies;
  /** Installed apps (feature 55): the transport and the retry timings. Tests give it fakes. */
  apps?: import("../apps/deliver").AppDependencies;
  /** Where the worker's database is. The appointment import opens its own small pool here to run the shared booking code (feature 12). */
  databaseUrl?: string;
  /** Payment providers and clock (feature 23). Tests pass fakes; the live worker passes the Stripe platform key. */
  payments?: import("../payments").PaymentDeps;
}

interface AppointmentRow {
  id: string;
  version: number;
  status: string;
  confirmation_status: string;
  starts_at: Date;
  clinic_name: string;
  clinic_timezone: string;
  booking_source: BookingOrigin;
  patient_id: string;
  preferred_channel: "sms" | "email" | "whatsapp" | "phone";
  messaging_consent: boolean;
  visit_started: boolean;
  /** Part of a repeating series: its one confirmation message goes out instead of one per visit (feature 17). */
  in_series: boolean;
  queue_number: number | null;
  whatsapp_enabled: boolean;
  sms_enabled: boolean;
}

function isSeriesBatch(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "seriesBatch" in payload && payload.seriesBatch === true;
}

/** The appointment as it is now, locked so a change can't land while the message is sent. */
async function currentAppointment(tenantDb: TenantDb, event: OutboxEvent): Promise<AppointmentRow | undefined> {
  const rows = await tenantDb`
    select appointment.id, appointment.version, appointment.status,
      appointment.confirmation_status, appointment.starts_at, appointment.booking_source,
      patient.id as patient_id, patient.preferred_channel,
      patient.messaging_consent_at is not null as messaging_consent,
      appointment.visit_started_at is not null as visit_started,
      appointment.series_id is not null as in_series,
      (
        select ticket.number from queue_tickets as ticket
        where ticket.tenant_id = appointment.tenant_id and ticket.appointment_id = appointment.id
      ) as queue_number,
      coalesce(settings.whatsapp_enabled, true) as whatsapp_enabled,
      coalesce(settings.sms_enabled, true) as sms_enabled,
      tenant.name as clinic_name, tenant.timezone as clinic_timezone
    from appointments as appointment
    join tenants as tenant on tenant.id = appointment.tenant_id
    join patients as patient
      on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    left join tenant_channel_settings as settings on settings.tenant_id = appointment.tenant_id
    where appointment.tenant_id = ${event.tenantId}
      and appointment.id = ${event.aggregateId}
    for update of appointment
  `;
  return rows[0] as AppointmentRow | undefined;
}

/**
 * Renders and sends one appointment message. It re-reads the appointment and drops the event
 * when the version in the event is no longer current (moved, edited or cancelled since), or
 * when the message no longer applies. `afterDelivery` runs only when a message went out.
 */
export function appointmentMessageHandler(
  { sink, now, available }: HandlerDependencies,
  afterDelivery?: (tenantDb: TenantDb, event: OutboxEvent, appointment: AppointmentRow) => Promise<void>,
  options: { forceChannel?: NotificationChannel } = {},
): EventHandler {
  return async (tenantDb, event) => {
    const at = now();
    const row = await currentAppointment(tenantDb, event);
    // Feature 17: one message covers the whole series (booked, changed or cancelled), so the visit's own message is not sent.
    if (row?.in_series && (event.eventType === "appointment.created" || isSeriesBatch(event.payload))) return "delivered";
    const appointment: AppointmentSnapshot | null = row ? {
      id: row.id,
      version: row.version,
      status: row.status,
      confirmationStatus: row.confirmation_status,
      startsAt: row.starts_at,
      clinicName: row.clinic_name,
      clinicTimezone: row.clinic_timezone,
      visitStarted: row.visit_started,
      queueNumber: row.queue_number === null ? undefined : Number(row.queue_number),
    } : null;
    const plan = planCapture({
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      dedupeKey: event.dedupeKey,
    }, appointment, at, row ? await tenantWords(tenantDb, event.tenantId) : undefined);
    if (plan.kind === "reject") return { outcome: "dead", code: plan.code };
    if (plan.kind === "skip" || !row) return "delivered";

    // A forced SMS (the WhatsApp fallback) still needs the business to have SMS on, the worker to be able to send it,
    // the customer's agreement and an SMS template for this message; otherwise nothing more is sent.
    if (options.forceChannel === "sms" && !smsAllowed(row, event.eventType, available)) return "delivered";
    const outcome = await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: row.id,
      patientId: row.patient_id,
      channel: options.forceChannel ?? routeChannel(row, event.eventType, available),
      message: plan.message,
    }, at);
    if (outcome === "delivered" && afterDelivery) await afterDelivery(tenantDb, event, row);
    return deliveryToHandlerOutcome(outcome);
  };
}

export function deliveryToHandlerOutcome(outcome: Awaited<ReturnType<MessageSink["deliver"]>>): HandlerOutcome {
  return outcome === "duplicate" ? "delivered" : outcome;
}

/**
 * The channel for one message: what the customer asked for and agreed to, limited to what this
 * business has switched on and the worker can send. WhatsApp and SMS only send approved
 * templates, so an event with no template for the channel goes by email.
 */
function smsAllowed(row: Pick<AppointmentRow, "messaging_consent" | "sms_enabled">, eventType: string, available: ChannelAvailability = { whatsapp: true, sms: true }): boolean {
  const template = channelTemplateFor(eventType);
  return row.messaging_consent && row.sms_enabled && available.sms && template !== null && smsTemplateKeys.has(template);
}

export function routeChannel(
  row: Pick<AppointmentRow, "booking_source" | "preferred_channel" | "messaging_consent" | "whatsapp_enabled" | "sms_enabled">,
  eventType: string,
  available: ChannelAvailability = { whatsapp: true, sms: true },
): NotificationChannel {
  const channel = notificationChannel(row.booking_source, row.preferred_channel, row.messaging_consent, {
    whatsapp: row.whatsapp_enabled && available.whatsapp,
    sms: row.sms_enabled && available.sms,
  });
  const template = channelTemplateFor(eventType);
  if (channel === "whatsapp" && !template) return "email";
  if (channel === "sms" && (!template || !smsTemplateKeys.has(template))) return "email";
  return channel;
}
