import { alertTime } from "../../lib/staff-alerts";
import { appointmentMessageHandler, type HandlerDependencies } from "./appointment-message";
import type { EventHandler } from "./types";
import { standDownForWorkflows } from "./workflow-message";

/**
 * The reminder the reminder sweep queues a day ahead. A reminder for an appointment that has
 * moved, been cancelled or already started is dropped. Once one is sent the appointment is
 * marked reminded, but only if it is still the same version, so a move made in between gets
 * its own reminder.
 */
export function appointmentReminderHandler(dependencies: HandlerDependencies): EventHandler {
  return standDownForWorkflows(appointmentMessageHandler(dependencies, async (tenantDb, event, appointment) => {
    await tenantDb`
      update appointments set reminder_status = 'delivered', updated_at = now()
      where tenant_id = ${event.tenantId} and id = ${appointment.id}
        and version = ${appointment.version} and reminder_status = 'queued'
    `;
    await queueCustomerPush(tenantDb, event.tenantId, appointment.id, appointment.patient_id, appointment.starts_at, appointment.clinic_timezone);
  }));
}

/**
 * A free extra reminder for a customer who installed the portal and allowed alerts. It follows the usual
 * message rather than replacing it, and says only the time. Queued only when they have a device.
 */
async function queueCustomerPush(
  tenantDb: Parameters<EventHandler>[0],
  tenantId: string,
  appointmentId: string,
  patientId: string,
  startsAt: Date,
  timeZone: string,
): Promise<void> {
  const [device] = await tenantDb`select 1 from push_subscriptions where tenant_id = ${tenantId} and patient_id = ${patientId} limit 1`;
  if (!device) return;
  const payload = { patientId, title: `Reminder: booking at ${alertTime(startsAt, timeZone)}`, link: "/portal", kind: "reminder" };
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'push', ${patientId}, 'push.send', ${tenantDb.json(payload)}, ${`push:reminder:${appointmentId}`})
    on conflict (tenant_id, dedupe_key) do nothing`;
}
