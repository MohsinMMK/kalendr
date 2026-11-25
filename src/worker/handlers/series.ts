import { createHash } from "node:crypto";

import { z } from "zod";

import { openManageToken } from "../../server/messaging/sealed-link";
import { notificationChannel, type NotificationChannel } from "../../lib/notification-routing";
import { channelTemplateFor } from "../../lib/channel-templates";
import { emailWhen } from "../email-adapter";
import { deliveryToHandlerOutcome, type HandlerDependencies } from "./appointment-message";
import type { EventHandler, TenantDb } from "./types";

/**
 * The one message for a whole repeating series (feature 17, event `series.confirmation`): every date in one list instead of
 * a confirmation per visit. It rides on the first visit's appointment, which is how erasure and the message log find it.
 * It lists the visits as they are when it is sent, so a visit cancelled in between is left out. Nothing here logs.
 */

const payloadSchema = z.object({
  seriesId: z.string().min(1),
  kind: z.enum(["booked", "changed", "cancelled"]),
  appointmentIds: z.array(z.string().min(1)).min(1).max(60),
  version: z.number().int().positive(),
});

interface VisitRow {
  id: string;
  starts_at: Date;
  status: string;
  manage_token_ciphertext: string | null;
  patient_id: string;
  preferred_channel: "sms" | "email" | "whatsapp" | "phone";
  messaging_consent: boolean;
  service_name: string;
  zone: string;
  whatsapp_enabled: boolean;
  sms_enabled: boolean;
}

async function loadVisits(tenantDb: TenantDb, tenantId: string, seriesId: string, ids: string[]): Promise<VisitRow[]> {
  const rows = await tenantDb`
    select appointment.id, appointment.starts_at, appointment.status, appointment.manage_token_ciphertext,
      patient.id as patient_id, patient.preferred_channel, patient.messaging_consent_at is not null as messaging_consent,
      service.name as service_name, coalesce(location.timezone, tenant.timezone) as zone,
      coalesce(settings.whatsapp_enabled, true) as whatsapp_enabled, coalesce(settings.sms_enabled, true) as sms_enabled
    from appointments as appointment
    join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    join tenants as tenant on tenant.id = appointment.tenant_id
    left join tenant_channel_settings as settings on settings.tenant_id = appointment.tenant_id
    where appointment.tenant_id = ${tenantId} and appointment.series_id = ${seriesId} and appointment.id in ${tenantDb(ids)}
    order by appointment.starts_at
  `;
  return rows as unknown as VisitRow[];
}

/** WhatsApp needs consent and an approved template; a text has no series wording, so it goes by email. A cancellation is email only. */
function channelsFor(row: VisitRow, kind: string, available: HandlerDependencies["available"]): NotificationChannel[] {
  if (kind === "cancelled") return ["email"];
  const first = notificationChannel("staff", row.preferred_channel, row.messaging_consent, {
    whatsapp: row.whatsapp_enabled && (available?.whatsapp ?? true),
    sms: row.sms_enabled && (available?.sms ?? true),
  });
  return first === "whatsapp" && channelTemplateFor(SERIES_TEMPLATE) ? ["whatsapp", "email"] : ["email"];
}

const SERIES_TEMPLATE = "series.confirmation";

export function seriesConfirmationHandler(dependencies: HandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const { sink, now, available, origin = "http://localhost:3000" } = dependencies;
    const at = now();
    const parsed = payloadSchema.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_payload" };
    const { seriesId, kind, appointmentIds, version } = parsed.data;

    const all = await loadVisits(tenantDb, event.tenantId, seriesId, appointmentIds);
    // A new or changed series lists only the visits still booked; a cancellation lists the visits that were cancelled.
    const visits = kind === "cancelled" ? all : all.filter((visit) => visit.status === "booked" || visit.status === "requested");
    const first = visits[0];
    if (!first) return "delivered";

    const token = kind === "cancelled" ? null : openManageToken(event.tenantId, first.id, first.manage_token_ciphertext);
    const dates = visits.map((visit) => emailWhen(visit.starts_at, visit.zone));
    const body = JSON.stringify({
      kind,
      service: first.service_name,
      dates,
      count: visits.length,
      // The one line WhatsApp shows: how many, and when the first is.
      when: `${visits.length} ${visits.length === 1 ? "visit" : "visits"}, from ${dates[0]}`,
      url: token ? `${origin}/manage/${encodeURIComponent(token)}` : "",
    });

    let lastCode = "undeliverable";
    for (const channel of channelsFor(first, kind, available)) {
      const semanticKey = `local:${channel}:${createHash("sha256").update(`series:${seriesId}:${kind}:${version}`).digest("hex")}`;
      const outcome = await sink.deliver(tenantDb, {
        tenantId: event.tenantId,
        appointmentId: first.id,
        patientId: first.patient_id,
        channel,
        message: { semanticKey, templateKey: SERIES_TEMPLATE, body, scheduledAt: at },
      }, at);
      if (outcome === "retry" || (typeof outcome === "object" && outcome.outcome === "retry")) return deliveryToHandlerOutcome(outcome);
      if (typeof outcome === "object") { lastCode = outcome.code; continue; }
      // The sink counts a deliberate skip (a bounced address, no number, a template not approved yet) as finished.
      const [saved] = await tenantDb`
        select status from notifications
        where tenant_id = ${event.tenantId} and semantic_key in (${semanticKey}, ${semanticKey.replace(/^local:[a-z]+:/, `${channel}:`)})
        limit 1
      ` as Array<{ status?: string }>;
      if (saved?.status === "cancelled") { lastCode = "skipped"; continue; }
      return "delivered";
    }
    return { outcome: "dead", code: lastCode.replace(/[^a-z0-9_.:-]/g, "_").slice(0, 60) };
  };
}
