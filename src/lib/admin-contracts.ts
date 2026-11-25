import { z } from "zod";

import { planKeySchema } from "@/lib/entitlements";

/**
 * Request and response shapes of the platform admin console (feature 15). Shared by `src/app/api/admin/*`,
 * the server code in `src/server/admin/*` and the screens in `src/app/admin/*`. Nothing here may carry a customer's
 * name, contact, a message body or record content.
 */

export const platformRoles = ["support", "billing", "super"] as const;
export type PlatformRole = (typeof platformRoles)[number];

/** Every action that changes something asks for a reason, kept in the audit trail. */
export const reasonSchema = z.string().trim().min(5, "Say why, in at least a few words.").max(300);

export const adminTenantListQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  status: z.enum(["all", "active", "paused"]).default("all"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export const adminTenantRowSchema = z.object({
  tenantId: z.string(),
  slug: z.string(),
  name: z.string(),
  businessType: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string().nullable(),
  isActive: z.boolean(),
  pausedAt: z.string().nullable(),
  staffCount: z.number().int(),
  setupStage: z.enum(["signed_up", "services_added", "first_booking"]),
  /** Filled by feature 14. Null when the business has no subscription row yet. */
  planKey: z.string().nullable().optional(),
  planStatus: z.string().nullable().optional(),
});
export type AdminTenantRow = z.infer<typeof adminTenantRowSchema>;

export const adminTenantListSchema = z.object({
  items: z.array(adminTenantRowSchema),
  total: z.number().int(),
  pageSize: z.number().int(),
});
export type AdminTenantList = z.infer<typeof adminTenantListSchema>;

export const adminSignupDaySchema = z.object({ day: z.string(), signups: z.number().int() });
export type AdminSignupDay = z.infer<typeof adminSignupDaySchema>;

export const adminTenantHealthSchema = z.object({
  tenantId: z.string(),
  slug: z.string(),
  name: z.string(),
  businessType: z.string(),
  createdAt: z.string(),
  isActive: z.boolean(),
  pausedAt: z.string().nullable(),
  /** The business's own switches from `tenants.features`. */
  features: z.record(z.string(), z.unknown()),
  staffCount: z.number().int(),
  appointments30d: z.number().int(),
  /** Keys look like `whatsapp:delivered`. */
  messages7d: z.record(z.string(), z.number()),
  recentErrors: z.array(z.object({ code: z.string(), count: z.number().int() })),
  deadLetters: z.number().int(),
  lastStaffActivityAt: z.string().nullable(),
  /** Filled by feature 14 (plan, status, trial end, usage). */
  billing: z.object({
    planKey: z.string().nullable(),
    status: z.string().nullable(),
    trialEndsAt: z.string().nullable(),
    currentPeriodEnd: z.string().nullable(),
    usage: z.record(z.string(), z.number()),
  }).nullable().optional(),
});
export type AdminTenantHealth = z.infer<typeof adminTenantHealthSchema>;

export const adminMessageRowSchema = z.object({
  notificationId: z.string(),
  tenantId: z.string(),
  appointmentId: z.string().nullable(),
  channel: z.string(),
  templateKey: z.string(),
  status: z.string(),
  attemptCount: z.number().int(),
  scheduledAt: z.string(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  failureCode: z.string().nullable(),
  costCategory: z.string().nullable(),
  hasProviderId: z.boolean(),
  /** Why it was or was not delivered, in a sentence for support. Built from the codes above, never from content. */
  explanation: z.string(),
  outbox: z.array(z.object({
    eventId: z.string(),
    eventType: z.string(),
    status: z.string(),
    attemptCount: z.number().int(),
    lastErrorCode: z.string().nullable(),
    availableAt: z.string(),
  })),
});
export type AdminMessageRow = z.infer<typeof adminMessageRowSchema>;

export const adminWorkerHealthSchema = z.object({
  pending: z.number().int(),
  oldestPendingSeconds: z.number().int(),
  deadLetters: z.number().int(),
  heartbeats: z.array(z.object({ workerId: z.string(), mode: z.string(), version: z.string(), lastSeenAt: z.string(), stoppedAt: z.string().nullable() })),
  deadLetterItems: z.array(z.object({ eventId: z.string(), tenantId: z.string(), eventType: z.string(), attempts: z.number().int(), lastErrorCode: z.string().nullable(), createdAt: z.string() })),
});
export type AdminWorkerHealth = z.infer<typeof adminWorkerHealthSchema>;

export const adminAbuseSchema = z.object({
  highVolume: z.array(z.object({ tenantId: z.string(), name: z.string(), messages24h: z.number().int() })),
  suppressions: z.array(z.object({ tenantId: z.string(), name: z.string(), count: z.number().int() })),
  newBusinesses24h: z.number().int(),
});

export type AdminAbuse = z.infer<typeof adminAbuseSchema>;

export const pauseInputSchema = z.object({ paused: z.boolean(), reason: reasonSchema });
export const reasonOnlyInputSchema = z.object({ reason: reasonSchema });
export const extendTrialInputSchema = z.object({ days: z.number().int().min(1).max(60), reason: reasonSchema });
export const changePlanInputSchema = z.object({ planKey: planKeySchema, reason: reasonSchema });
export const retryInputSchema = z.object({ eventId: z.string().min(8).max(80), reason: reasonSchema });

export const impersonateInputSchema = z.object({
  reason: z.string().trim().min(10, "Say why you need to look, in at least 10 characters.").max(300),
  /** Only the super role may ask for it. */
  write: z.boolean().default(false),
});

export const rolloutModes = ["off", "listed", "percent", "all"] as const;
export const rolloutInputSchema = z.object({
  featureKey: z.string().trim().min(2).max(60).regex(/^[a-z][a-z0-9_.-]*$/),
  mode: z.enum(rolloutModes),
  percent: z.number().int().min(0).max(100).default(0),
  tenantIds: z.array(z.string().min(8).max(80)).max(500).default([]),
  reason: reasonSchema,
});
export const rolloutRowSchema = z.object({
  featureKey: z.string(),
  mode: z.enum(rolloutModes),
  percent: z.number().int(),
  tenantIds: z.array(z.string()),
  updatedAt: z.string(),
});
export type RolloutRow = z.infer<typeof rolloutRowSchema>;

export const adminAuditRowSchema = z.object({
  id: z.string(),
  adminUserId: z.string(),
  tenantId: z.string().nullable(),
  action: z.string(),
  reason: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  occurredAt: z.string(),
});
export type AdminAuditRow = z.infer<typeof adminAuditRowSchema>;

/** What the "View as this business" banner reads from `/api/staff/me`. */
export const impersonationBannerSchema = z.object({
  sessionId: z.string(),
  endsAt: z.string(),
  writeAccess: z.boolean(),
  businessName: z.string(),
});
export type ImpersonationBanner = z.infer<typeof impersonationBannerSchema>;

/** Name of the cookie that holds the impersonation token (HttpOnly, SameSite=Strict, 30 minutes). */
export const impersonationCookieName = "kalendr_support_session";

/** One operator in the Operators screen. Only ids, never a name or contact. */
export const operatorRowSchema = z.object({
  userId: z.string(),
  role: z.enum(platformRoles),
  isActive: z.boolean(),
  createdAt: z.string(),
});
export type OperatorRow = z.infer<typeof operatorRowSchema>;

/** Add an operator by the sign-in email of an existing user, change a role, or switch one off. Super only. */
export const operatorInputSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  role: z.enum(platformRoles),
  active: z.boolean().default(true),
  reason: reasonSchema,
});

/** What `/api/admin/me` returns: who is signed in to the console and what their role allows. */
export const adminMeSchema = z.object({
  userId: z.string(),
  role: z.enum(platformRoles),
  capabilities: z.object({
    findMessages: z.boolean(), operate: z.boolean(), impersonate: z.boolean(), impersonateWrite: z.boolean(),
    manageRollouts: z.boolean(), manageOperators: z.boolean(),
  }),
});
export type AdminMe = z.infer<typeof adminMeSchema>;

/** What starting "View as this business" returns. The token itself only ever travels in the cookie. */
export const impersonationStartedSchema = z.object({ sessionId: z.string(), endsAt: z.string(), writeAccess: z.boolean() });
