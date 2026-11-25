import { createHash } from "node:crypto";

import { OFFER_SEAL_PURPOSE, endOffer, markOfferSent, planOfferSend } from "../../server/waitlist-offers";
import { openPrivate } from "../../server/messaging/sealed-link";
import { postgresRunner } from "../../server/workflows/runner";
import { notificationChannel, type NotificationChannel } from "../../lib/notification-routing";
import { channelTemplateFor, smsTemplateKeys } from "../../lib/channel-templates";
import { emailWhen } from "../email-adapter";
import { deliveryToHandlerOutcome, type HandlerDependencies } from "./appointment-message";
import type { EventHandler, TenantDb } from "./types";

interface OfferMessageRow {
  token_sealed: string | null;
  preferred_channel: "sms" | "email" | "whatsapp" | "phone";
  messaging_consent: boolean;
  patient_id: string;
  service_name: string;
  zone: string;
  whatsapp_enabled: boolean;
  sms_enabled: boolean;
}

async function loadOfferMessage(tenantDb: TenantDb, tenantId: string, offerId: string): Promise<OfferMessageRow | undefined> {
  const rows = await tenantDb`
    select offer.token_sealed, patient.id as patient_id, patient.preferred_channel,
      patient.messaging_consent_at is not null as messaging_consent,
      service.name as service_name, coalesce(location.timezone, tenant.timezone) as zone,
      coalesce(settings.whatsapp_enabled, true) as whatsapp_enabled, coalesce(settings.sms_enabled, true) as sms_enabled
    from slot_offers as offer
    join waitlist_entries as entry on entry.tenant_id = offer.tenant_id and entry.id = offer.entry_id
    join patients as patient on patient.tenant_id = entry.tenant_id and patient.id = entry.patient_id
    join services as service on service.tenant_id = offer.tenant_id and service.id = offer.service_id
    join locations as location on location.tenant_id = offer.tenant_id and location.id = offer.location_id
    join tenants as tenant on tenant.id = offer.tenant_id
    left join tenant_channel_settings as settings on settings.tenant_id = offer.tenant_id
    where offer.tenant_id = ${tenantId} and offer.id = ${offerId}
  `;
  return rows[0] as OfferMessageRow | undefined;
}

/**
 * Where the offer goes. WhatsApp needs the customer's consent and an approved template; the waitlist offer has no SMS
 * template, so a customer who prefers text gets email. Email is always the last choice, so an offer is never lost for
 * want of a channel.
 */
function channelsFor(row: OfferMessageRow, available: HandlerDependencies["available"]): NotificationChannel[] {
  const first = notificationChannel("online", row.preferred_channel, row.messaging_consent, {
    whatsapp: row.whatsapp_enabled && (available?.whatsapp ?? true),
    sms: row.sms_enabled && (available?.sms ?? true),
  });
  const template = channelTemplateFor("waitlist.offer");
  const usable = (first === "whatsapp" && template) || (first === "sms" && template && smsTemplateKeys.has(template)) ? first : "email";
  return usable === "email" ? ["email"] : [usable, "email"];
}

/**
 * Sends the message for one offer (event `waitlist-match`). The first offer for a freed time is made inside the cancel's
 * own transaction, so this runs a moment later (or at the end of quiet hours); a cascade step queues it the same way.
 * It re-checks everything first (still waiting, not in quiet hours, time still free), starts the answer clock from the
 * moment the message goes, and only then marks the offer sent. A message that cannot be delivered ends the offer and asks
 * the next person, so one bad address never stalls the line. Nothing here logs; the link is never written anywhere.
 */
export function waitlistMatchHandler(dependencies: HandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const { sink, now, available, origin = "http://localhost:3000" } = dependencies;
    const run = postgresRunner(tenantDb);
    const at = now();
    const offerId = event.aggregateId;
    const plan = await planOfferSend(run, event.tenantId, offerId, at);
    if (plan.kind !== "send") return "delivered";

    const row = await loadOfferMessage(tenantDb, event.tenantId, offerId);
    const token = row ? openPrivate(OFFER_SEAL_PURPOSE, event.tenantId, offerId, row.token_sealed) : null;
    if (!row || !token) {
      await endOffer(run, event.tenantId, offerId, "withdrawn", { now: at, reason: "undeliverable" });
      return { outcome: "dead", code: "sealed_unreadable" };
    }
    const body = JSON.stringify({
      url: `${origin}/offer/${encodeURIComponent(token)}`,
      when: emailWhen(plan.startsAt, row.zone),
      service: row.service_name,
      minutes: plan.minutes,
    });
    let lastCode = "undeliverable";
    for (const channel of channelsFor(row, available)) {
      const semanticKey = `local:${channel}:${createHash("sha256").update(`waitlist-offer:${offerId}`).digest("hex")}`;
      const outcome = await sink.deliver(tenantDb, {
        tenantId: event.tenantId,
        appointmentId: null,
        patientId: row.patient_id,
        channel,
        message: { semanticKey, templateKey: "waitlist.offer", body, scheduledAt: at },
      }, at);
      if (outcome === "retry" || (typeof outcome === "object" && outcome.outcome === "retry")) return deliveryToHandlerOutcome(outcome);
      if (typeof outcome === "object") { lastCode = outcome.code; continue; }
      // The sink counts a deliberate skip (a bounced address, no number, a template not approved yet) as finished.
      const [saved] = await tenantDb`
        select status from notifications
        where tenant_id = ${event.tenantId} and semantic_key in (${semanticKey}, ${semanticKey.replace(/^local:[a-z]+:/, `${channel}:`)})
        limit 1
      `;
      if ((saved as { status?: string } | undefined)?.status === "cancelled") { lastCode = "skipped"; continue; }
      await markOfferSent(run, event.tenantId, offerId, at, plan.expiresAt);
      return "delivered";
    }
    // Nobody could be reached: end this offer and ask the next person, then record the failure for staff.
    await endOffer(run, event.tenantId, offerId, "withdrawn", { now: at, reason: "undeliverable" });
    return { outcome: "dead", code: lastCode.replace(/[^a-z0-9_.:-]/g, "_").slice(0, 60) };
  };
}

/** The answer time ran out (event `offer-expire`): the offer ends and the next person is asked, or the time goes to public booking. */
export function offerExpireHandler(dependencies: HandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const at = dependencies.now();
    const [offer] = await tenantDb`
      select status, expires_at from slot_offers where tenant_id = ${event.tenantId} and id = ${event.aggregateId} for update
    ` as Array<{ status: string; expires_at: Date }>;
    if (!offer || offer.status !== "sent") return "delivered";
    if (new Date(offer.expires_at).getTime() > at.getTime()) return "retry";
    await endOffer(postgresRunner(tenantDb), event.tenantId, event.aggregateId, "expired", { now: at });
    return "delivered";
  };
}

