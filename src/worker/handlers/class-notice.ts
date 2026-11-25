import { createHash } from "node:crypto";

import { z } from "zod";


import { passOffer, SEAT_SEAL_PURPOSE } from "../../server/class-seats";
import { openPrivate } from "../../server/messaging/sealed-link";
import { postgresRunner } from "../../server/workflows/runner";
import { emailWhen } from "../email-adapter";
import { deliveryToHandlerOutcome, type HandlerDependencies } from "./appointment-message";
import type { EventHandler, TenantDb } from "./types";

/**
 * Messages about a place in a class (feature 18, event `class.notice`): a confirmation, a waiting-list notice, an offered
 * seat, a cancelled session, or a line from the business to everyone. They go by email only, since the class wording has no
 * approved WhatsApp or SMS template yet. The private link is opened from its sealed copy at send time and written nowhere.
 * Nothing here logs.
 */

const payloadSchema = z.object({
  enrolmentId: z.string().min(1),
  kind: z.enum(["enrolled", "waitlisted", "offer", "session_cancelled", "broadcast"]),
  message: z.string().max(500).optional(),
  minutes: z.number().int().min(1).max(600).optional(),
});

interface NoticeRow {
  patient_id: string;
  token_sealed: string | null;
  status: string;
  offer_expires_at: Date | null;
  session_status: string;
  starts_at: Date;
  service_name: string;
  zone: string;
}

async function loadNotice(tenantDb: TenantDb, tenantId: string, enrolmentId: string): Promise<NoticeRow | undefined> {
  const rows = await tenantDb`
    select e.patient_id, e.token_sealed, e.status, e.offer_expires_at, session.status as session_status, session.starts_at,
      service.name as service_name, coalesce(location.timezone, tenant.timezone) as zone
    from class_enrolments as e
    join class_sessions as session on session.tenant_id = e.tenant_id and session.id = e.session_id
    join services as service on service.tenant_id = e.tenant_id and service.id = session.service_id
    join locations as location on location.tenant_id = e.tenant_id and location.id = session.location_id
    join tenants as tenant on tenant.id = e.tenant_id
    where e.tenant_id = ${tenantId} and e.id = ${enrolmentId}
  `;
  return rows[0] as NoticeRow | undefined;
}

export function classNoticeHandler(dependencies: HandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const { sink, now, origin = "http://localhost:3000" } = dependencies;
    const at = now();
    const parsed = payloadSchema.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_payload" };
    const { enrolmentId, kind, message, minutes } = parsed.data;
    const row = await loadNotice(tenantDb, event.tenantId, enrolmentId);
    if (!row) return "delivered";
    // Say only what is still true: a seat offer that was taken or has lapsed, or a place already cancelled, is not worth a message.
    if (kind === "offer" && (row.status !== "waitlisted" || !row.offer_expires_at || new Date(row.offer_expires_at).getTime() <= at.getTime())) return "delivered";
    if (kind === "waitlisted" && row.status !== "waitlisted") return "delivered";

    const token = openPrivate(SEAT_SEAL_PURPOSE, event.tenantId, enrolmentId, row.token_sealed);
    const body = JSON.stringify({
      kind,
      service: row.service_name,
      when: emailWhen(row.starts_at, row.zone),
      message: message ?? "",
      minutes: minutes ?? 120,
      url: token ? `${origin}/class/${encodeURIComponent(token)}` : "",
    });
    const semanticKey = `local:email:${createHash("sha256").update(`class:${event.dedupeKey}`).digest("hex")}`;
    const outcome = await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: row.patient_id,
      channel: "email",
      message: { semanticKey, templateKey: "class.notice", body, scheduledAt: at },
    }, at);
    if (outcome === "retry" || (typeof outcome === "object" && outcome.outcome === "retry")) return deliveryToHandlerOutcome(outcome);
    if (typeof outcome === "object") return { outcome: "dead", code: outcome.code.replace(/[^a-z0-9_.:-]/g, "_").slice(0, 60) };
    return "delivered";
  };
}

/** An offered seat's answer time ran out: the person is passed over and the seat goes to the next one waiting. */
export function classOfferExpireHandler(dependencies: HandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const at = dependencies.now();
    const enrolmentId = event.aggregateId;
    const [row] = await tenantDb`
      select status, offer_expires_at from class_enrolments where tenant_id = ${event.tenantId} and id = ${enrolmentId}
    ` as Array<{ status: string; offer_expires_at: Date | null }>;
    if (!row || row.status !== "waitlisted" || !row.offer_expires_at) return "delivered";
    if (new Date(row.offer_expires_at).getTime() > at.getTime()) return "retry";
    await passOffer(postgresRunner(tenantDb), event.tenantId, enrolmentId, at, "expired");
    return "delivered";
  };
}


