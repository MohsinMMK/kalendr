import { notificationChannel } from "../../lib/notification-routing";
import { planRecordSharedCapture } from "../policy";
import { deliveryToHandlerOutcome, type HandlerDependencies } from "./appointment-message";
import { tenantWords } from "./words";
import type { EventHandler } from "./types";

/** A document was shared with a customer. The message says something is ready and never names it. */
export function recordSharedHandler({ sink, now }: HandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const rows = await tenantDb`
      select patient.id as patient_id, patient.preferred_channel,
        patient.messaging_consent_at is not null as messaging_consent, tenant.name as clinic_name
      from visit_records as record
      join tenants as tenant on tenant.id = record.tenant_id
      join patients as patient on patient.tenant_id = record.tenant_id and patient.id = record.patient_id
      where record.tenant_id = ${event.tenantId} and record.id = ${event.aggregateId} and record.status = 'shared'
    `;
    const row = rows[0] as {
      patient_id: string;
      preferred_channel: "sms" | "email" | "whatsapp" | "phone";
      messaging_consent: boolean;
      clinic_name: string;
    } | undefined;
    // Unshared since: nothing to say.
    if (!row) return "delivered";
    const at = now();
    const plan = planRecordSharedCapture({
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      dedupeKey: event.dedupeKey,
    }, row.clinic_name, at, await tenantWords(tenantDb, event.tenantId));
    if (plan.kind === "reject") return { outcome: "dead", code: plan.code };
    if (plan.kind === "skip") return "delivered";
    return deliveryToHandlerOutcome(await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: row.patient_id,
      channel: notificationChannel("staff", row.preferred_channel, row.messaging_consent),
      message: plan.message,
    }, at));
  };
}
