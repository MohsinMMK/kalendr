import { z } from "zod";

import {
  CAMPAIGN_EMAIL_KEY, CAMPAIGN_MESSAGE_EVENT, fillCampaignText, campaignSampleValues, type CampaignPayload,
} from "../../lib/campaign-contracts";
import { recheckSend } from "../../server/campaigns/audience";
import { campaignBookingPath, campaignServiceName, fanoutCampaign, loadCampaign, tenantFacts } from "../../server/campaigns/send";
import { openUnsubscribeToken, unsubscribeUrl } from "../../server/campaigns/tokens";
import { appOrigin } from "../../server/env";
import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { loadDataKeys } from "../../server/keys/ring";
import { openSecret } from "../../server/keys/secrets";
import { afterQuietHours, isQuietMinute, localMinuteOfDay } from "../../server/workflows/quiet-hours";
import { loadQuietHours } from "../../server/workflows/engine";
import { postgresRunner } from "../../server/workflows/runner";
import type { HandlerDependencies } from "./appointment-message";
import type { EventHandler, HandlerOutcome, TenantDb } from "./types";

/**
 * The three campaign events (feature 28). Nothing is logged: not the recipient, the name or the text. Codes say why a
 * message was skipped. A message goes out at most once: the send row is claimed by its status, the notification has a
 * unique semantic key, and the provider gets the same key as its idempotency key, so a worker that dies at any point
 * and restarts finds the work done and finishes the paperwork instead of sending again.
 */

const fanoutPayload = z.object({ campaignId: z.string().min(1) });
const sendPayload = z.object({ sendId: z.string().min(1) });
const testPayload = z.object({
  campaignId: z.string().min(1),
  userId: z.string().min(1),
  version: z.number().int().min(1),
  /** The owner's own number, sealed when the request was made. */
  phoneCiphertext: z.string().nullable().default(null),
});

export function campaignFanoutHandler({ now }: HandlerDependencies): EventHandler {
  return async (tenantDb, event): Promise<HandlerOutcome> => {
    const payload = fanoutPayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    await fanoutCampaign(postgresRunner(tenantDb), event.tenantId, payload.data.campaignId, now());
    return "delivered";
  };
}

interface SendRow {
  id: string;
  campaign_id: string;
  patient_id: string;
  cycle: string;
  status: string;
  channel: "email" | "whatsapp" | "sms";
  unsubscribe_token_ciphertext: string | null;
  campaign_status: string;
  first_name: string;
  last_name: string;
}

function buildPayload(input: {
  campaign: { id: string; subject: string; body: string; templateKey: string | null; channel: string; code: string };
  sendId: string; firstName: string; lastName: string; business: { name: string; phone: string | null; slug: string; service: string }; origin: string; unsubscribe: string;
}): CampaignPayload {
  const bookUrl = `${input.origin}${campaignBookingPath(input.business.slug, input.campaign.code, input.campaign.channel === "whatsapp" ? "whatsapp" : input.campaign.channel === "sms" ? "sms" : "email")}`;
  const values = {
    customer_first_name: input.firstName,
    customer_name: `${input.firstName} ${input.lastName}`.trim(),
    business_name: input.business.name,
    business_phone: input.business.phone ?? "",
    service: input.business.service,
    book_link: bookUrl,
  };
  return {
    v: 1,
    campaignId: input.campaign.id,
    sendId: input.sendId,
    text: fillCampaignText(input.campaign.body, values).trim(),
    subject: fillCampaignText(input.campaign.subject, values).replace(/\s+/g, " ").trim(),
    template: input.campaign.templateKey,
    service: input.business.service,
    bookUrl,
    unsubscribeUrl: input.unsubscribe,
  };
}

export function campaignSendHandler({ sink, now, origin }: HandlerDependencies): EventHandler {
  return async (tenantDb: TenantDb, event): Promise<HandlerOutcome> => {
    const payload = sendPayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const at = now();
    const run = postgresRunner(tenantDb);
    const [row] = await tenantDb<SendRow[]>`
      select send.id, send.campaign_id, send.patient_id, send.cycle, send.status, send.channel, send.unsubscribe_token_ciphertext,
        campaign.status as campaign_status, patient.first_name, patient.last_name
      from campaign_sends as send
      join campaigns as campaign on campaign.tenant_id = send.tenant_id and campaign.id = send.campaign_id
      join patients as patient on patient.tenant_id = send.tenant_id and patient.id = send.patient_id
      where send.tenant_id = ${event.tenantId} and send.id = ${payload.data.sendId}
      for update of send
    `;
    // Gone, or settled by an earlier attempt: nothing to do. This is what makes a restart safe.
    if (!row || row.status !== "queued") return "delivered";

    const settle = async (status: "sent" | "failed" | "skipped", reason: string | null) => {
      await tenantDb`
        update campaign_sends set status = ${status}, reason = ${reason}, sent_at = ${status === "sent" ? at : null}, updated_at = now()
        where tenant_id = ${event.tenantId} and id = ${row.id}
      `;
    };
    const wait = async (until: Date) => {
      await tenantDb`update campaign_sends set status = 'pending', send_at = ${until}, updated_at = now() where tenant_id = ${event.tenantId} and id = ${row.id}`;
    };

    if (row.campaign_status === "paused") { await wait(new Date(at.getTime() + 60 * 60_000)); return "delivered"; }
    if (row.campaign_status !== "active" && row.campaign_status !== "sending") { await settle("skipped", "campaign_ended"); return "delivered"; }

    const campaign = await loadCampaign(run, event.tenantId, row.campaign_id);
    if (!campaign) { await settle("skipped", "campaign_ended"); return "delivered"; }
    const facts = await tenantFacts(run, event.tenantId);

    const quiet = await loadQuietHours(run, event.tenantId);
    if (isQuietMinute(localMinuteOfDay(at, facts.timeZone), quiet.startMinute, quiet.endMinute)) {
      await wait(afterQuietHours(at, facts.timeZone, quiet.startMinute, quiet.endMinute));
      return "delivered";
    }

    // Everything is checked again now: consent may have been withdrawn, a booking made, another campaign sent first.
    const reason = await recheckSend(run, campaign, { tenantId: event.tenantId, now: at, timeZone: facts.timeZone }, { patientId: row.patient_id, cycle: row.cycle });
    if (reason) { await settle("skipped", reason); return "delivered"; }

    // Marketing never goes without a working unsubscribe link.
    const token = openUnsubscribeToken(event.tenantId, row.id, row.unsubscribe_token_ciphertext);
    if (!token) { await settle("skipped", "no_unsubscribe_link"); return "delivered"; }
    const service = await campaignServiceName(run, event.tenantId, campaign, row.patient_id);
    const base = origin ?? appOrigin();
    const message = buildPayload({
      campaign: { id: campaign.id ?? row.campaign_id, subject: campaign.subject, body: campaign.body, templateKey: campaign.templateKey, channel: campaign.channel, code: campaign.code },
      sendId: row.id, firstName: row.first_name, lastName: row.last_name,
      business: { name: facts.name, phone: facts.phone, slug: facts.slug, service: service ?? "" }, origin: base, unsubscribe: unsubscribeUrl(base, token),
    });

    const outcome = await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: row.patient_id,
      channel: row.channel,
      message: {
        semanticKey: `local:campaign:${row.id}`,
        templateKey: row.channel === "email" ? CAMPAIGN_EMAIL_KEY : CAMPAIGN_MESSAGE_EVENT,
        subject: message.subject,
        body: JSON.stringify(message),
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
    // "duplicate" means a message with this key already went (a worker that stopped before it settled the row): finish the paperwork.
    const [note] = await tenantDb<{ status: string; failure_code: string | null }[]>`
      select status, failure_code from notifications
      where tenant_id = ${event.tenantId} and semantic_key in (${`local:campaign:${row.id}`}, ${`${row.channel}:${row.id}`}) limit 1
    `;
    if (note?.status === "cancelled") await settle("skipped", note.failure_code ?? "not_sent");
    else if (note?.status === "failed") await settle("failed", note.failure_code ?? "provider_error");
    else await settle("sent", null);
    return "delivered";
  };
}

/** "Send me a test": the campaign as a real customer would get it, to the owner's own address or number. */
export function campaignTestHandler({ sink, now, origin }: HandlerDependencies): EventHandler {
  return async (tenantDb: TenantDb, event): Promise<HandlerOutcome> => {
    const payload = testPayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const at = now();
    const run = postgresRunner(tenantDb);
    const campaign = await loadCampaign(run, event.tenantId, payload.data.campaignId);
    if (!campaign || campaign.version !== payload.data.version) return "delivered";
    const facts = await tenantFacts(run, event.tenantId);
    const [user] = await tenantDb<{ email: string; name: string }[]>`
      select auth_user.email, auth_user.name from auth_users as auth_user join memberships as membership on membership.user_id = auth_user.id
      where membership.tenant_id = ${event.tenantId} and auth_user.id = ${payload.data.userId} limit 1
    `;
    if (!user) return { outcome: "dead", code: "no_destination" };
    const service = await campaignServiceName(run, event.tenantId, campaign);
    const base = origin ?? appOrigin();
    const message = buildPayload({
      campaign: { id: campaign.id ?? payload.data.campaignId, subject: `[Test] ${campaign.subject}`, body: campaign.body, templateKey: campaign.templateKey, channel: campaign.channel, code: campaign.code },
      sendId: `test-${event.id}`, firstName: user.name.split(" ")[0] || campaignSampleValues.customer_first_name, lastName: user.name.split(" ").slice(1).join(" "),
      business: { name: facts.name, phone: facts.phone, slug: facts.slug, service: service ?? campaignSampleValues.service }, origin: base,
      // A test never unsubscribes anyone: the link opens a page that says so.
      unsubscribe: unsubscribeUrl(base, "test-link-not-active"),
    });
    let phone: string | undefined;
    if (campaign.channel !== "email") {
      if (!payload.data.phoneCiphertext) return { outcome: "dead", code: "no_destination" };
      await loadDataKeys(postgresDataKeyStore(tenantDb), event.tenantId);
      try {
        phone = openSecret(event.tenantId, "campaign.test-phone", payload.data.phoneCiphertext);
      } catch {
        return { outcome: "dead", code: "no_destination" };
      }
    }
    const outcome = await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: `staff:${payload.data.userId}`,
      channel: campaign.channel,
      ...(campaign.channel === "email" ? { testRecipientEmail: user.email } : { testRecipientPhone: phone }),
      message: {
        semanticKey: `local:campaign:test:${event.id}`,
        templateKey: campaign.channel === "email" ? CAMPAIGN_EMAIL_KEY : CAMPAIGN_MESSAGE_EVENT,
        subject: message.subject,
        body: JSON.stringify(message),
        scheduledAt: at,
      },
    }, at);
    if (typeof outcome === "object") return outcome;
    if (outcome === "retry" || outcome === "dead") return outcome;
    // The test counts only for the words it was sent with: editing the campaign afterwards asks for a new one.
    await tenantDb`
      update campaigns set tested_version = ${payload.data.version}, tested_at = ${at}, updated_at = now()
      where tenant_id = ${event.tenantId} and id = ${payload.data.campaignId} and version = ${payload.data.version}
    `;
    return "delivered";
  };
}


