import { z } from "zod";

import { planKeySchema, planLimitsSchema, subscriptionStatuses } from "@/lib/entitlements";

/**
 * Request and response shapes of subscription billing (feature 14), shared by `src/app/api/staff/billing/*`,
 * `src/server/billing/*` and the "Plan and billing" screens. Kalendr's own subscription billing only: customer
 * payments (feature 23) are separate and must not be mixed in here. Nothing here holds a card or UPI detail.
 */

export const billingProviders = ["razorpay", "stripe"] as const;
export type BillingProvider = (typeof billingProviders)[number];

/** The error code the server answers with when a plan does not allow something. Screens open the upgrade dialog on it. */
export const planLimitErrorCode = "plan_limit";

export const planLimitDetailsSchema = z.object({
  /** The feature or metric that was refused, such as `staffCalendars` or `whatsapp`. */
  subject: z.string(),
  /** The cheapest plan that allows it, or null when none does. */
  requiredPlan: planKeySchema.nullable(),
  currentPlan: planKeySchema,
  /** The limit on the current plan, when the subject is a number. */
  limit: z.number().int().nullable(),
});
export type PlanLimitDetails = z.infer<typeof planLimitDetailsSchema>;

export const billingPlanViewSchema = z.object({
  key: planKeySchema,
  name: z.string(),
  /** In the business's billing currency, smallest unit. */
  priceMinor: z.number().int(),
  currency: z.enum(["INR", "USD"]),
  limits: planLimitsSchema,
});
export type BillingPlanView = z.infer<typeof billingPlanViewSchema>;

export const billingUsageSchema = z.object({
  metric: z.string(),
  used: z.number().int(),
  /** null means there is no included amount to compare with (unlimited, or the plan has none). */
  included: z.number().int().nullable(),
});

export const billingInvoiceSchema = z.object({
  id: z.string(),
  invoiceNumber: z.string(),
  issuedAt: z.string(),
  planKey: planKeySchema,
  currency: z.string(),
  amountMinor: z.number().int(),
  gstMinor: z.number().int(),
  totalMinor: z.number().int(),
  kalendrGstin: z.string().nullable(),
  buyerGstin: z.string().nullable(),
});
export type BillingInvoice = z.infer<typeof billingInvoiceSchema>;

export const billingStateSchema = z.object({
  /** What the business can use now (see `effectivePlanKey`), and the stored subscription behind it. */
  plan: z.object({
    key: planKeySchema,
    name: z.string(),
    status: z.enum(subscriptionStatuses),
    reason: z.string(),
    trialEndsAt: z.string().nullable(),
    graceEndsAt: z.string().nullable(),
    currentPeriodEnd: z.string().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    pendingPlanKey: planKeySchema.nullable(),
  }),
  provider: z.enum(billingProviders).nullable(),
  /** Which provider checkout will use for this business (by country). */
  checkoutProvider: z.enum(billingProviders),
  currency: z.enum(["INR", "USD"]),
  plans: z.array(billingPlanViewSchema),
  usage: z.array(billingUsageSchema),
  overageMode: z.enum(["stop_marketing", "bill_overage"]),
  billingGstin: z.string().nullable(),
  invoices: z.array(billingInvoiceSchema),
  /** Shown to owners only: payment failed, and when full service ends. */
  banner: z.object({ kind: z.literal("past_due"), graceEndsAt: z.string() }).nullable(),
  /** True when keys for the provider are set, so checkout can run. False in preview and before the owner adds accounts. */
  checkoutAvailable: z.boolean(),
});
export type BillingState = z.infer<typeof billingStateSchema>;

export const checkoutInputSchema = z.object({ planKey: planKeySchema.exclude(["free"]) });
export const checkoutResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("redirect"), url: z.string().url() }),
  /** Razorpay opens its own sheet in the page, using the public key id and the subscription id. */
  z.object({ kind: z.literal("razorpay"), keyId: z.string(), subscriptionId: z.string() }),
  /** The plan changed with no payment step (for example a downgrade scheduled for the period end). */
  z.object({ kind: z.literal("done") }),
]);
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;

export const changePlanInputSchema = z.object({ planKey: planKeySchema });
export const billingSettingsInputSchema = z.object({
  overageMode: z.enum(["stop_marketing", "bill_overage"]).optional(),
  billingGstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "That doesn't look like a GSTIN.").nullable().optional(),
  version: z.number().int().optional(),
});
