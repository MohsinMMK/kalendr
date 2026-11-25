/**
 * Campaigns and win-back (feature 28): the shapes the routes, the server, the worker and the screens share, and the
 * rules that need no database (presets, limits, the wording of a message).
 *
 * No "server-only" import: the worker and the browser use this file.
 */
import { z } from "zod";

export const campaignChannels = ["email", "whatsapp", "sms"] as const;
export type CampaignChannel = (typeof campaignChannels)[number];
export const campaignChannelLabels: Record<CampaignChannel, string> = { email: "Email", whatsapp: "WhatsApp", sms: "Text message" };

export const campaignKinds = ["automated", "one_off"] as const;
export type CampaignKind = (typeof campaignKinds)[number];

export const campaignStatuses = ["draft", "active", "paused", "sending", "completed", "cancelled"] as const;
export type CampaignStatus = (typeof campaignStatuses)[number];

export const campaignStatusLabels: Record<CampaignStatus, string> = {
  draft: "Draft", active: "On", paused: "Paused", sending: "Sending", completed: "Finished", cancelled: "Cancelled",
};

export const ruleTypes = ["recall", "birthday", "win_back", "package_expiring", "routing_abandoned"] as const;
export type RuleType = (typeof ruleTypes)[number];

// ---- Limits that protect the business's reputation ----------------------------------------------------------------

/** At most one marketing message per customer in this many days, across every campaign. */
export const MARKETING_GAP_DAYS = 7;
/** A booking this soon after a message, through its link, is credited to the campaign. */
export const ATTRIBUTION_DAYS = 7;
/** How long a customer qualifies for an automated campaign after they first do: a recall for a visit six months ago still catches them for a month. */
export const CATCH_UP_DAYS = 30;
/** Messages handed on per minute for each business, so a big list is sent at a steady rate instead of in one burst. */
export const SENDS_PER_MINUTE: Record<CampaignChannel, number> = { email: 60, whatsapp: 30, sms: 30 };
/** A campaign with this many settled messages is judged on its rates. */
export const HEALTH_SAMPLE = 20;
/** More than this share of failed messages pauses a campaign. */
export const MAX_FAILURE_RATE = 0.15;
/** More than this share of people unsubscribing pauses a campaign. */
export const MAX_UNSUBSCRIBE_RATE = 0.03;

export type CampaignHealth = { ok: true } | { ok: false; reason: "high_failures" | "high_unsubscribes" };

/** Whether a campaign should carry on, from how its messages have gone so far. Failures are judged first. */
export function judgeCampaignHealth(counts: { sent: number; failed: number; unsubscribed: number }): CampaignHealth {
  const settled = counts.sent + counts.failed;
  if (settled < HEALTH_SAMPLE) return { ok: true };
  if (counts.failed / settled > MAX_FAILURE_RATE) return { ok: false, reason: "high_failures" };
  if (counts.sent > 0 && counts.unsubscribed / counts.sent > MAX_UNSUBSCRIBE_RATE) return { ok: false, reason: "high_unsubscribes" };
  return { ok: true };
}

export const pausedReasonText: Record<"high_failures" | "high_unsubscribes", string> = {
  high_failures: "Too many messages could not be delivered, so it paused itself. Check the details below, then turn it back on.",
  high_unsubscribes: "More people than usual unsubscribed, so it paused itself. Read the message again, then turn it back on if you still want to send it.",
};

// ---- Message words --------------------------------------------------------------------------------------------------

export const campaignFields = [
  { key: "customer_first_name", label: "First name", example: "Priya" },
  { key: "customer_name", label: "Full name", example: "Priya Sharma" },
  { key: "business_name", label: "Business name", example: "Riverbend Care" },
  { key: "business_phone", label: "Business phone", example: "+91 98000 00000" },
  { key: "service", label: "Service", example: "Check-up" },
  { key: "book_link", label: "Booking link", example: "https://kalendr.example/book/riverbend" },
] as const;

export type CampaignField = (typeof campaignFields)[number]["key"];
const fieldKeys: ReadonlySet<string> = new Set(campaignFields.map((field) => field.key));
function isCampaignField(name: string): name is CampaignField {
  return fieldKeys.has(name);
}
const FIELD_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function unknownCampaignFields(text: string): string[] {
  const unknown: string[] = [];
  for (const match of text.matchAll(FIELD_PATTERN)) {
    const name = match[1] ?? "";
    if (!fieldKeys.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/** Fills the known `{names}`; a name with no value becomes empty, an unknown one is left as written. */
export function fillCampaignText(text: string, values: Partial<Record<CampaignField, string>>): string {
  return text.replace(FIELD_PATTERN, (whole, name: string) => (isCampaignField(name) ? values[name] ?? "" : whole));
}

export const campaignSampleValues: Record<CampaignField, string> = {
  customer_first_name: "Priya",
  customer_name: "Priya Sharma",
  business_name: "Riverbend Care",
  business_phone: "+91 98000 00000",
  service: "Check-up",
  book_link: "https://kalendr.example/book/riverbend",
};

// ---- Automated rules ------------------------------------------------------------------------------------------------

export const recallRuleSchema = z.strictObject({
  type: z.literal("recall"),
  /** A service and how long after it a customer is due back: "6 months for a check-up". */
  services: z.array(z.strictObject({ serviceId: z.string().trim().min(1).max(80), intervalDays: z.number().int().min(7).max(1825) })).min(1).max(20),
});
export const birthdayRuleSchema = z.strictObject({ type: z.literal("birthday") });
export const winBackRuleSchema = z.strictObject({ type: z.literal("win_back"), daysAway: z.number().int().min(30).max(1095) });
export const packageRuleSchema = z.strictObject({ type: z.literal("package_expiring"), daysBefore: z.number().int().min(1).max(60) });

/** Feature 46: someone answered a routing form, was sent to book, and did not. Only customers Kalendr already knows by email, and only with marketing consent (the audience rules apply as for every campaign). */
export const routingAbandonedRuleSchema = z.strictObject({ type: z.literal("routing_abandoned"), hoursAfter: z.number().int().min(1).max(72) });

export const campaignRuleSchema = z.discriminatedUnion("type", [recallRuleSchema, birthdayRuleSchema, winBackRuleSchema, packageRuleSchema, routingAbandonedRuleSchema]);
export type CampaignRule = z.infer<typeof campaignRuleSchema>;

export const ruleLabels: Record<RuleType, { title: string; hint: string }> = {
  recall: { title: "Recall", hint: "Reminds people a while after a visit that they are due again." },
  birthday: { title: "Birthday", hint: "A greeting on the day, with a reason to come in." },
  win_back: { title: "Win-back", hint: "Reaches people who have not been for a long time." },
  package_expiring: { title: "Package about to expire", hint: "Nudges people who still have sessions left." },
  routing_abandoned: { title: "Answered but did not book", hint: "Follows up with people who answered one of your routing forms and then did not book." },
};

export function describeRule(rule: CampaignRule, serviceName: (id: string) => string = () => "a service"): string {
  switch (rule.type) {
    case "recall": return rule.services.map((entry) => `${describeDays(entry.intervalDays)} after ${serviceName(entry.serviceId)}`).join(", ");
    case "birthday": return "On their birthday";
    case "win_back": return `No visit for ${describeDays(rule.daysAway)}`;
    case "package_expiring": return `${rule.daysBefore} ${rule.daysBefore === 1 ? "day" : "days"} before a package runs out`;
    case "routing_abandoned": return `${rule.hoursAfter} ${rule.hoursAfter === 1 ? "hour" : "hours"} after answering a form without booking`;
  }
}

function describeDays(days: number): string {
  if (days % 365 === 0) return `${days / 365} ${days === 365 ? "year" : "years"}`;
  if (days % 30 === 0 && days >= 60) return `${days / 30} months`;
  return `${days} days`;
}

// ---- Content --------------------------------------------------------------------------------------------------------

/** The WhatsApp marketing templates Kalendr submits for approval. Only an approved one can ever be sent. */
export const whatsappMarketingTemplates = [
  { key: "campaign_recall", label: "Time for your next visit", fits: ["recall"], needsMessage: false },
  { key: "campaign_birthday", label: "Birthday greeting", fits: ["birthday"], needsMessage: false },
  { key: "campaign_winback", label: "We'd love to see you again", fits: ["win_back"], needsMessage: false },
  { key: "campaign_package", label: "Sessions left on your package", fits: ["package_expiring"], needsMessage: false },
  { key: "campaign_offer", label: "An offer in your own words", fits: ["offer", "routing_abandoned"], needsMessage: true },
] as const satisfies readonly { key: string; label: string; fits: readonly string[]; needsMessage: boolean }[];

export const whatsappTemplateKeys = whatsappMarketingTemplates.map((entry) => entry.key);

const contentSchema = z.strictObject({
  channel: z.enum(campaignChannels),
  subject: z.string().trim().max(200).default(""),
  /** Email: the message. Text and WhatsApp: the one line the template carries ("10% off all week"). */
  body: z.string().trim().max(4_000).default(""),
  templateKey: z.string().trim().max(60).nullable().default(null),
});

function checkContent(value: z.infer<typeof contentSchema>, context: z.RefinementCtx): void {
  if (value.channel === "email") {
    if (!value.subject) context.addIssue({ code: "custom", path: ["subject"], message: "Write a subject line." });
    if (!value.body) context.addIssue({ code: "custom", path: ["body"], message: "Write the message." });
  } else if (value.channel === "whatsapp") {
    if (!value.templateKey || !(whatsappTemplateKeys as readonly string[]).includes(value.templateKey)) {
      context.addIssue({ code: "custom", path: ["templateKey"], message: "Choose one of the approved WhatsApp messages." });
    }
    if (value.templateKey === "campaign_offer" && !value.body) context.addIssue({ code: "custom", path: ["body"], message: "Write the one line of the offer." });
  } else if (!value.body) {
    context.addIssue({ code: "custom", path: ["body"], message: "Write the one line of the message." });
  }
  if (value.channel !== "email" && (value.body.length > 160 || value.body.includes("\n"))) {
    context.addIssue({ code: "custom", path: ["body"], message: "Keep it to one line of 160 characters." });
  }
  const unknown = unknownCampaignFields(`${value.subject} ${value.body}`);
  if (unknown.length > 0) context.addIssue({ code: "custom", path: ["body"], message: `We don't know {${unknown[0]}}. Pick a field from the list.` });
}

const name = z.string().trim().min(1, "Give the campaign a name.").max(120);

export const oneOffCampaignInputSchema = contentSchema.extend({
  kind: z.literal("one_off"),
  name,
  segmentId: z.string().trim().min(1, "Choose who it goes to.").max(80),
  serviceId: z.string().trim().min(1).max(80).nullable().default(null),
  /** Empty means send as soon as it is turned on. */
  scheduledAt: z.iso.datetime({ offset: true }).nullable().default(null),
}).superRefine(checkContent);

export const automatedCampaignInputSchema = contentSchema.extend({
  kind: z.literal("automated"),
  name,
  rule: campaignRuleSchema,
  presetKey: z.string().trim().max(40).nullable().default(null),
}).superRefine(checkContent);

export const campaignInputSchema = z.discriminatedUnion("kind", [oneOffCampaignInputSchema, automatedCampaignInputSchema]);
export type CampaignInput = z.infer<typeof campaignInputSchema>;

export const campaignUpdateSchema = z.object({ version: z.number().int().min(1) }).and(campaignInputSchema);
export type CampaignUpdate = z.infer<typeof campaignUpdateSchema>;

export const campaignActionSchema = z.strictObject({
  action: z.enum(["start", "pause", "resume", "cancel"]),
  version: z.number().int().min(1),
});

export const campaignTestSchema = z.strictObject({
  /** Text and WhatsApp tests go to the owner's own number. Email tests go to their sign-in address. */
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{8,20}$/, "Enter your own number, with the country code.").optional(),
});

export const presetActivationSchema = z.strictObject({
  channel: z.enum(campaignChannels).default("email"),
  /** Recall presets need the services and how long after each. */
  recallServices: recallRuleSchema.shape.services.optional(),
  daysAway: z.number().int().min(30).max(1095).optional(),
  daysBefore: z.number().int().min(1).max(60).optional(),
  templateKey: z.string().trim().max(60).nullable().default(null),
});
export type PresetActivation = z.infer<typeof presetActivationSchema>;

export const audienceQuerySchema = z.object({
  /** For a campaign that is not saved yet. */
  segmentId: z.string().trim().max(80).optional(),
});

// ---- Presets --------------------------------------------------------------------------------------------------------

export interface CampaignPreset {
  key: string;
  ruleType: RuleType;
  name: string;
  description: string;
  subject: string;
  body: string;
  templateKey: string;
  /** What the owner is asked for when they turn it on. */
  asks: "services" | "daysAway" | "daysBefore" | "nothing";
  defaultIntervalDays: number;
  defaultDaysAway: number;
  defaultDaysBefore: number;
}

type Flavour = "clinical" | "wellness" | "other";

function flavourOf(businessType: string): Flavour {
  if (businessType === "healthcare" || businessType === "dental") return "clinical";
  if (businessType === "wellness") return "wellness";
  return "other";
}

const recallDays: Record<Flavour, number> = { clinical: 180, wellness: 45, other: 90 };

/** The ready-made campaigns shown for a business type, all switched off until the owner turns one on. */
export function campaignPresets(businessType: string): CampaignPreset[] {
  const flavour = flavourOf(businessType);
  const interval = recallDays[flavour];
  const months = Math.round(interval / 30);
  const recallName = interval >= 60 ? `${months}-month recall` : `${interval}-day recall`;
  const care = flavour === "clinical" ? "check-up" : flavour === "wellness" ? "next session" : "next visit";
  return [
    {
      key: "recall", ruleType: "recall", name: recallName, asks: "services",
      description: `Reminds people about a ${care} once the time you choose has passed since their last visit.`,
      subject: "Time for your {service}?",
      body: `Hi {customer_first_name},\n\nIt has been a while since your last {service} with {business_name}. If you'd like to book your ${care}, you can pick a time here:\n\n{book_link}\n\nSee you soon,\n{business_name}`,
      templateKey: "campaign_recall", defaultIntervalDays: interval, defaultDaysAway: 90, defaultDaysBefore: 14,
    },
    {
      key: "birthday", ruleType: "birthday", name: "Birthday greeting", asks: "nothing",
      description: "A short greeting on their birthday, with a link to book.",
      subject: "Happy birthday from {business_name}",
      body: "Hi {customer_first_name},\n\nHappy birthday from everyone at {business_name}! If you'd like to treat yourself, book here:\n\n{book_link}",
      templateKey: "campaign_birthday", defaultIntervalDays: interval, defaultDaysAway: 90, defaultDaysBefore: 14,
    },
    {
      key: "win_back", ruleType: "win_back", name: "Win-back after 90 days", asks: "daysAway",
      description: "Reaches people who have not been in for a long time and have nothing booked.",
      subject: "We'd love to see you again",
      body: "Hi {customer_first_name},\n\nIt's been a while since we saw you at {business_name}. If you'd like to come back, you can book a time here:\n\n{book_link}",
      templateKey: "campaign_winback", defaultIntervalDays: interval, defaultDaysAway: 90, defaultDaysBefore: 14,
    },
    {
      key: "package_expiring", ruleType: "package_expiring", name: "Package about to expire", asks: "daysBefore",
      description: "Nudges people who still have sessions left shortly before the package runs out.",
      subject: "Your sessions at {business_name} are running out",
      body: "Hi {customer_first_name},\n\nYou still have sessions left on your package with {business_name}, and it is about to expire. Book one here:\n\n{book_link}",
      templateKey: "campaign_package", defaultIntervalDays: interval, defaultDaysAway: 90, defaultDaysBefore: 14,
    },
  ];
}

// ---- What the screens show -------------------------------------------------------------------------------------------

export const leftOutReasons = [
  "blocked", "under_18", "no_marketing_consent", "channel_not_agreed", "no_contact", "future_booking", "recent_message", "already_sent",
] as const;
export type LeftOutReason = (typeof leftOutReasons)[number];

export const leftOutLabels: Record<LeftOutReason, string> = {
  blocked: "Blocked from booking",
  under_18: "Under 18, so never sent marketing",
  no_marketing_consent: "Have not agreed to marketing messages",
  channel_not_agreed: "Have not agreed to marketing on this channel",
  no_contact: "No email address or phone number to use",
  future_booking: "Already have a booking coming up",
  recent_message: `Got a marketing message in the last ${MARKETING_GAP_DAYS} days`,
  already_sent: "Already sent this campaign",
};

export interface AudiencePreview {
  /** Everyone the rule or segment picks, before consent and limits. */
  matching: number;
  /** Who would get it right now. */
  eligible: number;
  leftOut: { reason: LeftOutReason; label: string; count: number }[];
  /** Whatsapp and text only: the guess at what sending would cost, and what the plan still includes. */
  cost: CostEstimate | null;
}

export interface CostEstimate {
  channel: "whatsapp" | "sms";
  messages: number;
  /** In the smallest unit. An estimate: the provider's own price list decides the real figure. */
  estimateMinor: number;
  currency: string;
  includedThisMonth: number;
  usedThisMonth: number;
  /** How many of these messages the plan covers, the rest being past the allowance. */
  coveredByPlan: number;
  overage: "stop_marketing" | "bill_overage";
}

/** The provider's price for one marketing message, in paise, for the estimate only. */
export const ESTIMATE_UNIT_MINOR: Record<"whatsapp" | "sms", number> = { whatsapp: 78, sms: 25 };

export interface CampaignStats {
  planned: number;
  sent: number;
  delivered: number;
  failed: number;
  skipped: number;
  booked: number;
  unsubscribed: number;
  revenueMinor: number;
  currency: string;
}

export interface CampaignSummary {
  id: string;
  name: string;
  kind: CampaignKind;
  ruleType: RuleType | null;
  presetKey: string | null;
  channel: CampaignChannel;
  status: CampaignStatus;
  pausedReason: "high_failures" | "high_unsubscribes" | null;
  segmentId: string | null;
  segmentName: string | null;
  rule: CampaignRule | null;
  subject: string;
  body: string;
  templateKey: string | null;
  serviceId: string | null;
  scheduledAt: string | null;
  code: string;
  version: number;
  /** True when the current words and channel were test-sent to the owner. A campaign cannot go out before that. */
  tested: boolean;
  stats: CampaignStats;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignPreview {
  customerFirstName: string;
  subject: string;
  body: string;
  /** WhatsApp and text: the approved template and what is put in each place. */
  template: { key: string; label: string; approved: boolean } | null;
  bookLink: string;
}

export interface WhatsAppTemplateStatus {
  key: string;
  label: string;
  approved: boolean;
}

export interface CampaignChannelStatus {
  channel: CampaignChannel;
  ready: boolean;
  reason: string;
}

/** The body the worker's adapters read for a campaign message. The same JSON goes to every channel. */
export const campaignPayloadSchema = z.object({
  v: z.literal(1),
  campaignId: z.string(),
  sendId: z.string(),
  /** Email: the filled message. Text and WhatsApp: the one line. */
  text: z.string(),
  subject: z.string(),
  template: z.string().nullable(),
  service: z.string(),
  bookUrl: z.string(),
  unsubscribeUrl: z.string(),
});
export type CampaignPayload = z.infer<typeof campaignPayloadSchema>;

export const CAMPAIGN_FANOUT_EVENT = "campaign.fanout";
export const CAMPAIGN_SEND_EVENT = "campaign.send";
export const CAMPAIGN_TEST_EVENT = "campaign.test";
/** The one event name the WhatsApp and text adapters and the plan gate know a campaign message by. */
export const CAMPAIGN_MESSAGE_EVENT = "campaign.message";
/** The template key the email adapter knows a campaign message by. */
export const CAMPAIGN_EMAIL_KEY = "campaign:email";
