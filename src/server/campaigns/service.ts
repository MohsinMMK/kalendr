import "server-only";

import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import {
  campaignPresets, campaignRuleSchema, ESTIMATE_UNIT_MINOR, fillCampaignText, campaignSampleValues, leftOutLabels, leftOutReasons, whatsappMarketingTemplates,
  type AudiencePreview, type CampaignChannel, type CampaignChannelStatus, type CampaignInput, type CampaignPreview, type CampaignRule, type CampaignStats, type CampaignStatus, type CampaignSummary,
  type CampaignUpdate, type CostEstimate, type PresetActivation, type WhatsAppTemplateStatus, CAMPAIGN_TEST_EVENT,
} from "@/lib/campaign-contracts";
import { segmentFilterSchema } from "@/lib/segment-filter";
import { ApiError } from "@/server/api-error";
import { loadBusinessProfileIn } from "@/server/business-profile";
import { requireFeature } from "@/server/entitlements";
import { claimKey, finishKey } from "@/server/idempotent";
import { sealSecret } from "@/server/keys/secrets";
import { loadRecordKeys } from "@/server/record-crypto";
import { assertNotReadOnlyImpersonation, requirePermission, type StaffContext } from "@/server/staff-context";
import { workflowChannelStatuses } from "@/server/workflows/channels";
import { drizzleRunner } from "@/server/workflows/runner";

import { auditCustomer } from "@/server/customers/access";
import { loadAudience, type AudienceCampaign } from "./audience";
import { campaignStats } from "./attribution";
import { campaignBookingPath, campaignServiceName, tenantFacts } from "./send";

/**
 * Campaigns and win-back (feature 28), the web app's side: setting a campaign up, previewing who it reaches, test-sending
 * it, turning it on and off, and reading its results. Sending is the worker's job; nothing here calls a provider.
 */

interface CampaignDbRow extends Record<string, unknown> {
  id: string;
  name: string;
  kind: "automated" | "one_off";
  rule_type: string | null;
  rule: Record<string, unknown>;
  preset_key: string | null;
  segment_id: string | null;
  segment_filter: unknown;
  channel: CampaignChannel;
  subject: string | null;
  body: string | null;
  template_key: string | null;
  service_id: string | null;
  status: CampaignStatus;
  scheduled_at: Date | string | null;
  paused_reason: string | null;
  tested_version: number | null;
  code: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  segment_name: string | null;
}

function parseRule(row: CampaignDbRow): CampaignRule | null {
  if (!row.rule_type) return null;
  const parsed = campaignRuleSchema.safeParse({ ...row.rule, type: row.rule_type });
  return parsed.success ? parsed.data : null;
}

function pausedReason(value: string | null): CampaignSummary["pausedReason"] {
  return value === "high_failures" || value === "high_unsubscribes" ? value : null;
}

function toSummary(row: CampaignDbRow, stats: CampaignStats): CampaignSummary {
  const rule = parseRule(row);
  return {
    id: row.id, name: row.name, kind: row.kind, ruleType: rule?.type ?? null, presetKey: row.preset_key, channel: row.channel, status: row.status,
    pausedReason: pausedReason(row.paused_reason), segmentId: row.segment_id, segmentName: row.segment_name, rule,
    subject: row.subject ?? "", body: row.body ?? "", templateKey: row.template_key, serviceId: row.service_id,
    scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null, code: row.code, version: row.version,
    tested: row.tested_version === row.version, stats,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const SELECT = sql`
  select campaign.*, segment.name as segment_name from campaigns as campaign
  left join customer_segments as segment on segment.tenant_id = campaign.tenant_id and segment.id = campaign.segment_id
`;

function requireCampaigns(context: StaffContext): void {
  requirePermission(context, "campaigns.manage");
}

function requirePlanForChannel(context: StaffContext, channel: CampaignChannel): void {
  if (channel === "whatsapp") requireFeature(context, "whatsapp");
  if (channel === "sms") requireFeature(context, "sms");
}

export async function listCampaigns(context: StaffContext): Promise<CampaignSummary[]> {
  requireCampaigns(context);
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const run = drizzleRunner(transaction);
    const rows = await transaction.execute<CampaignDbRow>(sql`${SELECT} where campaign.tenant_id = ${context.tenantId} order by campaign.created_at desc limit 200`);
    const stats = await campaignStats(run, context.tenantId);
    return rows.map((row) => toSummary(row, stats.get(row.id)));
  });
}

async function readCampaign(transaction: KalendrTransaction, context: StaffContext, campaignId: string, lock = false): Promise<CampaignDbRow> {
  const [row] = await transaction.execute<CampaignDbRow>(sql`${SELECT} where campaign.tenant_id = ${context.tenantId} and campaign.id = ${campaignId} ${lock ? sql`for update of campaign` : sql``}`);
  if (!row) throw new ApiError(404, "campaign_not_found", "That campaign no longer exists.");
  return row;
}

export async function getCampaign(context: StaffContext, campaignId: string): Promise<CampaignSummary> {
  requireCampaigns(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Campaigns need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const row = await readCampaign(transaction, context, campaignId);
    return toSummary(row, (await campaignStats(drizzleRunner(transaction), context.tenantId, campaignId)).get(campaignId));
  });
}

function newCode(): string {
  return `c${randomBytes(6).toString("hex")}`;
}

async function assertContentAllowed(transaction: KalendrTransaction, context: StaffContext, input: CampaignInput): Promise<void> {
  requirePlanForChannel(context, input.channel);
  if (input.channel === "whatsapp") {
    // Only a template that exists in the approved list can ever be chosen; whether Meta has approved it is checked when it goes out.
    if (!whatsappMarketingTemplates.some((entry) => entry.key === input.templateKey)) {
      throw new ApiError(400, "validation_error", "Choose one of the approved WhatsApp messages.", { templateKey: ["Choose one of the approved WhatsApp messages."] });
    }
  }
  if (input.kind === "automated" && input.rule.type === "recall") {
    const ids = input.rule.services.map((entry) => entry.serviceId);
    const [{ found } = { found: 0 }] = await transaction.execute<{ found: number }>(sql`select count(*)::int as found from services where tenant_id = ${context.tenantId} and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    if (Number(found) !== new Set(ids).size) throw new ApiError(400, "validation_error", "One of those services no longer exists.", { rule: ["One of those services no longer exists."] });
  }
  if (input.kind === "one_off" && input.serviceId) {
    const [service] = await transaction.execute<{ id: string }>(sql`select id from services where tenant_id = ${context.tenantId} and id = ${input.serviceId}`);
    if (!service) throw new ApiError(400, "validation_error", "That service no longer exists.", { serviceId: ["That service no longer exists."] });
  }
}

async function segmentFilterFor(transaction: KalendrTransaction, context: StaffContext, segmentId: string): Promise<Record<string, unknown>> {
  const [row] = await transaction.execute<{ filter: unknown }>(sql`select filter from customer_segments where tenant_id = ${context.tenantId} and id = ${segmentId}`);
  const parsed = row ? segmentFilterSchema.safeParse(row.filter) : null;
  if (!parsed?.success) throw new ApiError(400, "validation_error", "That segment no longer exists.", { segmentId: ["That segment no longer exists."] });
  return parsed.data;
}

function storedParts(input: CampaignInput): { rule: Record<string, unknown>; ruleType: string | null; serviceId: string | null } {
  if (input.kind === "automated") {
    const { type, ...rest } = input.rule;
    return { rule: rest, ruleType: type, serviceId: null };
  }
  return { rule: {}, ruleType: null, serviceId: input.serviceId };
}

export async function createCampaign(context: StaffContext, input: CampaignInput, idempotencyKey: string): Promise<CampaignSummary> {
  assertNotReadOnlyImpersonation(context);
  requireCampaigns(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Campaigns need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<CampaignSummary>(transaction, context.tenantId, "staff.campaign.create", idempotencyKey, input);
    if ("replay" in claim) return claim.replay;
    await assertContentAllowed(transaction, context, input);
    const filter = input.kind === "one_off" ? await segmentFilterFor(transaction, context, input.segmentId) : null;
    const parts = storedParts(input);
    const [created] = await transaction.execute<{ id: string }>(sql`
      insert into campaigns (tenant_id, name, kind, rule_type, rule, preset_key, segment_id, segment_filter, channel, subject, body, template_key, service_id, scheduled_at, code, created_by_user_id)
      values (${context.tenantId}, ${input.name}, ${input.kind}, ${parts.ruleType}, ${JSON.stringify(parts.rule)}::jsonb, ${input.kind === "automated" ? input.presetKey : null},
        ${input.kind === "one_off" ? input.segmentId : null}, ${filter ? JSON.stringify(filter) : null}::jsonb, ${input.channel}, ${input.subject}, ${input.body}, ${input.channel === "whatsapp" ? input.templateKey : null},
        ${parts.serviceId}, ${input.kind === "one_off" ? input.scheduledAt : null}::timestamptz, ${newCode()}, ${context.userId})
      on conflict do nothing returning id
    `);
    if (!created) throw new ApiError(409, "preset_exists", "That ready-made campaign is already set up. Open it from the list.");
    await auditCustomer(transaction, context, "campaign.created", null, { campaignId: created.id, kind: input.kind, channel: input.channel });
    const row = await readCampaign(transaction, context, created.id);
    const summary = toSummary(row, (await campaignStats(drizzleRunner(transaction), context.tenantId, created.id)).get(created.id));
    await finishKey(transaction, claim.claimId, summary);
    return summary;
  });
}

export async function updateCampaign(context: StaffContext, campaignId: string, input: CampaignUpdate): Promise<CampaignSummary> {
  assertNotReadOnlyImpersonation(context);
  requireCampaigns(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Campaigns need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const existing = await readCampaign(transaction, context, campaignId, true);
    if (existing.version !== input.version) throw new ApiError(409, "version_conflict", "Someone else changed this campaign. Reload it and try again.");
    if (existing.kind !== input.kind) throw new ApiError(400, "validation_error", "A campaign can't change between automated and one-off.");
    if (existing.status === "sending" || existing.status === "completed" || existing.status === "cancelled") {
      throw new ApiError(409, "campaign_locked", "This campaign has already gone out, so it can't be changed. Make a new one instead.");
    }
    await assertContentAllowed(transaction, context, input);
    const filter = input.kind === "one_off" ? await segmentFilterFor(transaction, context, input.segmentId) : null;
    const parts = storedParts(input);
    await transaction.execute(sql`
      update campaigns set name = ${input.name}, rule_type = ${parts.ruleType}, rule = ${JSON.stringify(parts.rule)}::jsonb,
        segment_id = ${input.kind === "one_off" ? input.segmentId : null}, segment_filter = ${filter ? JSON.stringify(filter) : null}::jsonb,
        channel = ${input.channel}, subject = ${input.subject}, body = ${input.body}, template_key = ${input.channel === "whatsapp" ? input.templateKey : null},
        service_id = ${parts.serviceId}, scheduled_at = ${input.kind === "one_off" ? input.scheduledAt : null}::timestamptz,
        version = version + 1, updated_at = now()
      where tenant_id = ${context.tenantId} and id = ${campaignId}
    `);
    await auditCustomer(transaction, context, "campaign.updated", null, { campaignId });
    const row = await readCampaign(transaction, context, campaignId);
    return toSummary(row, (await campaignStats(drizzleRunner(transaction), context.tenantId, campaignId)).get(campaignId));
  });
}

async function templateStatuses(transaction: KalendrTransaction): Promise<WhatsAppTemplateStatus[]> {
  const rows = await transaction.execute<{ key: string; status: string }>(sql`select key, status from message_templates where channel = 'whatsapp' and language = 'en' and key like 'campaign_%'`);
  const byKey = new Map(rows.map((row) => [row.key, row.status]));
  return whatsappMarketingTemplates.map((entry) => ({ key: entry.key, label: entry.label, approved: byKey.get(entry.key) === "approved" }));
}

export async function campaignOptions(context: StaffContext): Promise<{
  presets: ReturnType<typeof campaignPresets>;
  templates: WhatsAppTemplateStatus[];
  channels: CampaignChannelStatus[];
}> {
  requireCampaigns(context);
  const channels = workflowChannelStatuses().map((status) => ({ channel: status.key, ready: status.ready, reason: status.reason }));
  if (context.preview) return { presets: campaignPresets("healthcare"), templates: [], channels };
  return withTenant(context.tenantId, async (transaction) => {
    const profile = await loadBusinessProfileIn(transaction, context.tenantId);
    return { presets: campaignPresets(profile.businessType), templates: await templateStatuses(transaction), channels };
  });
}

export async function activatePreset(context: StaffContext, presetKey: string, activation: PresetActivation, idempotencyKey: string): Promise<CampaignSummary> {
  assertNotReadOnlyImpersonation(context);
  requireCampaigns(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Campaigns need a database.");
  const businessType = await withTenant(context.tenantId, async (transaction) => (await loadBusinessProfileIn(transaction, context.tenantId)).businessType);
  const preset = campaignPresets(businessType).find((entry) => entry.key === presetKey);
  if (!preset) throw new ApiError(404, "preset_not_found", "We could not find that ready-made campaign.");
  const rule = campaignRuleSchema.safeParse(
    preset.ruleType === "recall" ? { type: "recall", services: activation.recallServices ?? [] }
      : preset.ruleType === "birthday" ? { type: "birthday" }
        : preset.ruleType === "win_back" ? { type: "win_back", daysAway: activation.daysAway ?? preset.defaultDaysAway }
          : { type: "package_expiring", daysBefore: activation.daysBefore ?? preset.defaultDaysBefore },
  );
  if (!rule.success) throw new ApiError(400, "validation_error", "Choose a service and how long after it to remind people.", { recallServices: ["Choose at least one service."] });
  const created = await createCampaign(context, {
    kind: "automated", name: preset.name, rule: rule.data, presetKey: preset.key, channel: activation.channel,
    subject: preset.subject, body: activation.channel === "email" ? preset.body : "", templateKey: activation.channel === "whatsapp" ? preset.templateKey : null,
  }, idempotencyKey);
  // One click turns it on: a preset is words the owner has not written, so it needs no test.
  return setCampaignStatus(context, created.id, { action: "start", version: created.version });
}

function readiness(channel: CampaignChannel): CampaignChannelStatus {
  const status = workflowChannelStatuses().find((entry) => entry.key === channel);
  return { channel, ready: status?.ready ?? false, reason: status?.reason ?? "" };
}

export async function setCampaignStatus(context: StaffContext, campaignId: string, input: { action: "start" | "pause" | "resume" | "cancel"; version: number }): Promise<CampaignSummary> {
  assertNotReadOnlyImpersonation(context);
  requireCampaigns(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Campaigns need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const row = await readCampaign(transaction, context, campaignId, true);
    if (row.version !== input.version) throw new ApiError(409, "version_conflict", "Someone else changed this campaign. Reload it and try again.");
    let next: CampaignStatus;
    if (input.action === "start") {
      if (row.status !== "draft") throw new ApiError(409, "invalid_state", "This campaign has already been turned on.");
      requirePlanForChannel(context, row.channel);
      const channel = readiness(row.channel);
      if (!channel.ready) throw new ApiError(409, "channel_not_ready", channel.reason);
      if (row.channel === "whatsapp") {
        const approved = (await templateStatuses(transaction)).find((entry) => entry.key === row.template_key)?.approved;
        if (!approved) throw new ApiError(409, "template_not_approved", "This WhatsApp message is still waiting for Meta's approval, so it can't be sent yet.");
      }
      // A one-off send to a whole segment goes out only after the owner has seen it arrive. A ready-made recall needs no test.
      if (row.kind === "one_off" && row.tested_version !== row.version) throw new ApiError(409, "test_required", "Send yourself a test first. It checks how the message looks before it goes to everyone.");
      next = "active";
    } else if (input.action === "pause") {
      if (row.status !== "active" && row.status !== "sending") throw new ApiError(409, "invalid_state", "Only a campaign that is running can be paused.");
      next = "paused";
    } else if (input.action === "resume") {
      if (row.status !== "paused") throw new ApiError(409, "invalid_state", "This campaign is not paused.");
      requirePlanForChannel(context, row.channel);
      const [started] = await transaction.execute<{ started_at: Date | null }>(sql`select started_at from campaigns where tenant_id = ${context.tenantId} and id = ${campaignId}`);
      next = row.kind === "one_off" && started?.started_at ? "sending" : "active";
    } else {
      if (row.status === "completed" || row.status === "cancelled") throw new ApiError(409, "invalid_state", "This campaign has already finished.");
      next = "cancelled";
    }
    await transaction.execute(sql`
      update campaigns set status = ${next}, paused_reason = null, version = version + 1, updated_at = now(),
        completed_at = ${next === "cancelled" ? sql`now()` : sql`completed_at`}
      where tenant_id = ${context.tenantId} and id = ${campaignId}
    `);
    if (next === "cancelled") {
      await transaction.execute(sql`
        update campaign_sends set status = 'skipped', reason = 'campaign_cancelled', updated_at = now()
        where tenant_id = ${context.tenantId} and campaign_id = ${campaignId} and status in ('pending', 'queued')
      `);
    }
    await auditCustomer(transaction, context, `campaign.${input.action === "start" ? "started" : input.action === "pause" ? "paused" : input.action === "resume" ? "resumed" : "cancelled"}`, null, { campaignId });
    const updated = await readCampaign(transaction, context, campaignId);
    return toSummary(updated, (await campaignStats(drizzleRunner(transaction), context.tenantId, campaignId)).get(campaignId));
  });
}

function audienceOf(row: CampaignDbRow): AudienceCampaign {
  const rule = parseRule(row);
  const filter = row.segment_filter ? segmentFilterSchema.safeParse(row.segment_filter) : null;
  return {
    id: row.id, kind: row.kind, channel: row.channel, rule,
    segmentFilter: filter?.success ? filter.data : row.kind === "one_off" ? { all: [{ field: "visits", op: "lt", value: 0 }] } : null,
    serviceId: row.service_id,
  };
}

async function estimateCost(transaction: KalendrTransaction, context: StaffContext, channel: CampaignChannel, messages: number): Promise<CostEstimate | null> {
  if (channel === "email") return null;
  const [usage] = await transaction.execute<{ count: number }>(sql`
    select count from usage_counters where tenant_id = ${context.tenantId} and period = date_trunc('month', now() at time zone 'utc')::date and metric = ${`message:${channel}`}
  `);
  const [subscription] = await transaction.execute<{ overage_mode: string }>(sql`select overage_mode from tenant_subscriptions where tenant_id = ${context.tenantId}`);
  const [tenant] = await transaction.execute<{ currency: string }>(sql`select currency from tenants where id = ${context.tenantId}`);
  const included = context.entitlements?.limits.messagesIncluded[channel] ?? 0;
  const used = Number(usage?.count ?? 0);
  return {
    channel, messages, estimateMinor: messages * ESTIMATE_UNIT_MINOR[channel], currency: tenant?.currency ?? "INR",
    includedThisMonth: included, usedThisMonth: used, coveredByPlan: Math.max(0, Math.min(messages, included - used)),
    overage: subscription?.overage_mode === "bill_overage" ? "bill_overage" : "stop_marketing",
  };
}

/** Who the campaign would reach right now, who was left out and why, and what sending would cost. */
export async function previewAudience(context: StaffContext, campaignId: string): Promise<AudiencePreview> {
  requireCampaigns(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Campaigns need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const row = await readCampaign(transaction, context, campaignId);
    const facts = await tenantFacts(drizzleRunner(transaction), context.tenantId);
    const audience = await loadAudience(drizzleRunner(transaction), audienceOf(row), { tenantId: context.tenantId, now: new Date(), timeZone: facts.timeZone }, { limit: 0 });
    return {
      matching: audience.matching,
      eligible: audience.eligibleCount,
      leftOut: leftOutReasons.map((reason) => ({ reason, label: leftOutLabels[reason], count: audience.leftOut[reason] })).filter((entry) => entry.count > 0),
      cost: await estimateCost(transaction, context, row.channel, audience.eligibleCount) ?? null,
    };
  });
}

/** The message as a real customer in the audience would get it (staff only see this). */
export async function previewMessage(context: StaffContext, campaignId: string, origin: string): Promise<CampaignPreview> {
  requireCampaigns(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Campaigns need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const row = await readCampaign(transaction, context, campaignId);
    const run = drizzleRunner(transaction);
    const facts = await tenantFacts(run, context.tenantId);
    const audience = await loadAudience(run, audienceOf(row), { tenantId: context.tenantId, now: new Date(), timeZone: facts.timeZone }, { limit: 1 });
    const member = audience.eligible[0];
    const [customer] = member
      ? await transaction.execute<{ first_name: string; last_name: string }>(sql`select first_name, last_name from patients where tenant_id = ${context.tenantId} and id = ${member.patientId}`)
      : [];
    const service = await campaignServiceName(run, context.tenantId, audienceOf(row), member?.patientId);
    const bookLink = `${origin}${campaignBookingPath(facts.slug, row.code, row.channel)}`;
    const values = {
      customer_first_name: customer?.first_name ?? campaignSampleValues.customer_first_name,
      customer_name: customer ? `${customer.first_name} ${customer.last_name}`.trim() : campaignSampleValues.customer_name,
      business_name: facts.name, business_phone: facts.phone ?? "", service: service ?? campaignSampleValues.service, book_link: bookLink,
    };
    const templates = await templateStatuses(transaction);
    const template = row.template_key ? templates.find((entry) => entry.key === row.template_key) : undefined;
    return {
      customerFirstName: values.customer_first_name,
      subject: fillCampaignText(row.subject ?? "", values).replace(/\s+/g, " ").trim(),
      body: fillCampaignText(row.body ?? "", values).trim(),
      template: template ? { key: template.key, label: template.label, approved: template.approved } : null,
      bookLink,
    };
  });
}

/** Queues "send me a test". Email goes to the person's sign-in address; text and WhatsApp go to the number they give. */
export async function requestTestSend(context: StaffContext, campaignId: string, input: { phone?: string }, idempotencyKey: string): Promise<{ queued: true }> {
  assertNotReadOnlyImpersonation(context);
  requireCampaigns(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Campaigns need a database.");
  if (!context.userId) throw new ApiError(400, "no_user", "Sign in as a person to send a test.");
  const userId = context.userId;
  return withTenant(context.tenantId, async (transaction) => {
    const row = await readCampaign(transaction, context, campaignId);
    if (row.status === "completed" || row.status === "cancelled") throw new ApiError(409, "campaign_locked", "This campaign has finished.");
    requirePlanForChannel(context, row.channel);
    let phoneCiphertext: string | null = null;
    if (row.channel !== "email") {
      if (!input.phone) throw new ApiError(400, "validation_error", "Enter your own number to get the test.", { phone: ["Enter your own number to get the test."] });
      await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
      phoneCiphertext = sealSecret(context.tenantId, "campaign.test-phone", input.phone);
    }
    await transaction.execute(sql`
      insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${context.tenantId}, 'campaign', ${campaignId}, ${CAMPAIGN_TEST_EVENT},
        ${JSON.stringify({ campaignId, userId, version: row.version, phoneCiphertext })}::jsonb, ${`${CAMPAIGN_TEST_EVENT}:${campaignId}:${idempotencyKey}`.slice(0, 200)})
      on conflict (tenant_id, dedupe_key) do nothing
    `);
    await auditCustomer(transaction, context, "campaign.test_requested", null, { campaignId, channel: row.channel });
    return { queued: true as const };
  });
}

export async function deleteCampaign(context: StaffContext, campaignId: string): Promise<{ deleted: true }> {
  assertNotReadOnlyImpersonation(context);
  requireCampaigns(context);
  if (context.preview) throw new ApiError(400, "preview_only", "Campaigns need a database.");
  return withTenant(context.tenantId, async (transaction) => {
    const row = await readCampaign(transaction, context, campaignId, true);
    // Only a campaign that never sent anything can be removed; anything else is kept for its results and cancelled instead.
    const [sent] = await transaction.execute<{ n: number }>(sql`select count(*)::int as n from campaign_sends where tenant_id = ${context.tenantId} and campaign_id = ${campaignId} and status in ('queued', 'sent', 'failed')`);
    if (Number(sent?.n ?? 0) > 0 || row.status === "active" || row.status === "sending") {
      throw new ApiError(409, "campaign_has_history", "This campaign has been running or has sent messages. Cancel it instead; its results stay.");
    }
    await transaction.execute(sql`delete from campaigns where tenant_id = ${context.tenantId} and id = ${campaignId}`);
    await auditCustomer(transaction, context, "campaign.deleted", null, { campaignId });
    return { deleted: true as const };
  });
}
