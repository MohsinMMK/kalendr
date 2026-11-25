import { z } from "zod";

import type { WebhookEventType } from "../../lib/api-scopes";
import {
  envelope, eventIdFor, isAppointmentEvent, paymentEventDataSchema, type WebhookEnvelope,
} from "../../server/webhooks/payloads";
import type { OutboxEvent, TenantDb } from "../handlers/types";

/** Builds the public envelope for an outbox row. Shared by webhook fan-out and app delivery so both send the same facts. */

interface AppointmentRow {
  status: string;
  starts_at: Date;
  ends_at: Date;
  service_id: string;
  practitioner_id: string;
  patient_id: string;
  location_id: string;
  version: number;
}

const versionPayload = z.object({ version: z.number().int().optional() });

/** Builds the envelope for an outbox row, or null when there is nothing to send (the appointment is gone, say). */
export async function buildEnvelope(tenantDb: TenantDb, event: OutboxEvent, type: WebhookEventType, now: Date): Promise<WebhookEnvelope | null> {
  if (isAppointmentEvent(type)) {
    const rows = await tenantDb`
      select status, starts_at, ends_at, service_id, practitioner_id, patient_id, location_id, version
      from appointments where tenant_id = ${event.tenantId} and id = ${event.aggregateId}
    `;
    const row = rows[0] as AppointmentRow | undefined;
    if (!row) return null;
    // The id follows the version the event was queued for, so cancel and status-cancelled collapse into one event.
    const queuedVersion = versionPayload.safeParse(event.payload).data?.version ?? row.version;
    return envelope(eventIdFor([type, event.aggregateId, String(queuedVersion)]), type, {
      appointmentId: event.aggregateId,
      status: row.status,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      serviceId: row.service_id,
      staffId: row.practitioner_id,
      customerId: row.patient_id,
      locationId: row.location_id,
      version: row.version,
    }, now);
  }
  if (type === "customer.created") {
    return envelope(eventIdFor([type, event.aggregateId]), type, { customerId: event.aggregateId }, now);
  }
  const payment = paymentEventDataSchema.safeParse(event.payload);
  return payment.success ? envelope(eventIdFor([type, payment.data.paymentId]), type, payment.data, now) : null;
}

