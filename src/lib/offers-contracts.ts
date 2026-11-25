import { z } from "zod";

import { cleanGstin, isGstStateCode, isValidGstin } from "@/lib/gst";
import { couponKinds, isValidCode, normaliseCode, type CouponKind, type MembershipStatus } from "@/lib/offers";
import { MAX_PAYMENT_MINOR } from "@/lib/money";

/** Request and response shapes for packages, memberships and coupons (feature 25), shared by the routes and the screens. */

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const serviceIds = z.array(idSchema).min(1).max(100);
const amount = z.number().int().positive().max(MAX_PAYMENT_MINOR);
const dateField = z.iso.datetime({ offset: true });

export const deskMethods = ["cash", "upi", "card", "bank"] as const;

export const packageInputSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(400).nullish(),
  priceMinor: amount,
  credits: z.number().int().min(1).max(200),
  validDays: z.number().int().min(1).max(3650),
  serviceIds,
  isActive: z.boolean().default(true),
  version: z.number().int().min(1).optional(),
});
export type PackageInput = z.infer<typeof packageInputSchema>;

export interface PackageView {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  credits: number;
  validDays: number;
  serviceIds: string[];
  isActive: boolean;
  version: number;
  /** Packages sold and credits not yet spent, for the owner's report. */
  sold: number;
  creditsOutstanding: number;
}

export const sellPackageInputSchema = z.strictObject({
  patientId: idSchema,
  packageId: idSchema,
  locationId: idSchema,
  /** What was taken at the desk, split across methods if needed. Part payment is allowed; the rest stays owing on the invoice. */
  payments: z.array(z.strictObject({ method: z.enum(deskMethods), amountMinor: amount })).min(1).max(4),
  buyerGstin: z.string().trim().transform(cleanGstin).refine(isValidGstin, "That GSTIN does not look right.").optional(),
  buyerStateCode: z.string().refine(isGstStateCode, "Choose a state from the list.").optional(),
});
export type SellPackageInput = z.infer<typeof sellPackageInputSchema>;

export const adjustCreditsInputSchema = z.strictObject({
  change: z.number().int().min(-200).max(200).refine((value) => value !== 0, "Enter how many credits to add or take away."),
  reason: z.string().trim().min(2).max(200),
});
export type AdjustCreditsInput = z.infer<typeof adjustCreditsInputSchema>;

export interface CreditEntryView {
  id: string;
  change: number;
  kind: "purchase" | "renewal" | "grant" | "use" | "return" | "expiry" | "adjust";
  reason: string;
  appointmentId: string | null;
  at: string;
}

export interface CustomerPackageView {
  id: string;
  patientId: string;
  name: string;
  source: "package" | "membership" | "gift";
  creditsTotal: number;
  remaining: number;
  boughtAt: string;
  expiresAt: string;
  /** `active` has credits and time left; `used_up` has no credits; `expired` ran out of time. */
  status: "active" | "used_up" | "expired";
  serviceIds: string[];
  invoiceId: string | null;
  ledger: CreditEntryView[];
}

export const membershipPlanInputSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(400).nullish(),
  priceMinor: amount,
  creditsPerPeriod: z.number().int().min(0).max(100),
  memberDiscountPercent: z.number().int().min(0).max(100),
  serviceIds,
  isActive: z.boolean().default(true),
  version: z.number().int().min(1).optional(),
}).refine((value) => value.creditsPerPeriod > 0 || value.memberDiscountPercent > 0, { path: ["creditsPerPeriod"], message: "Give members credits each month, a discount, or both." });
export type MembershipPlanInput = z.infer<typeof membershipPlanInputSchema>;

export interface MembershipPlanView {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  creditsPerPeriod: number;
  memberDiscountPercent: number;
  serviceIds: string[];
  isActive: boolean;
  version: number;
  activeMembers: number;
}

export const enrolMembershipInputSchema = z.strictObject({ patientId: idSchema, planId: idSchema, /** How the first month was paid at the desk. */ method: z.enum(deskMethods) });
export type EnrolMembershipInput = z.infer<typeof enrolMembershipInputSchema>;

export const membershipActionInputSchema = z.strictObject({ action: z.enum(["cancel", "pause", "resume", "renew"]), method: z.enum(deskMethods).optional() });

export interface CustomerMembershipView {
  id: string;
  patientId: string;
  planId: string;
  planName: string;
  status: MembershipStatus;
  currentPeriodEnd: string;
  /** Benefits (credits, member price) are on right now. */
  benefitsOn: boolean;
  /** While a renewal has failed: when the grace period ends. */
  graceEndsAt: string | null;
}

const couponCode = z.string().trim().transform(normaliseCode).refine(isValidCode, "A code is 3 to 32 letters, numbers, dashes or underscores.");

export const couponInputSchema = z.strictObject({
  code: couponCode,
  kind: z.enum(couponKinds),
  value: z.number().int().positive().max(MAX_PAYMENT_MINOR),
  maxUses: z.number().int().positive().max(1_000_000).nullish(),
  perCustomerLimit: z.number().int().positive().max(1000).nullish(),
  validFrom: dateField.nullish(),
  validTo: dateField.nullish(),
  serviceIds: z.array(idSchema).max(100).default([]),
  firstVisitOnly: z.boolean().default(false),
  stackable: z.boolean().default(false),
  isActive: z.boolean().default(true),
  version: z.number().int().min(1).optional(),
}).superRefine((value, context) => {
  if (value.kind === "percent" && value.value > 100) context.addIssue({ code: "custom", path: ["value"], message: "A percentage can't be more than 100." });
  if (value.validFrom && value.validTo && Date.parse(value.validFrom) >= Date.parse(value.validTo)) context.addIssue({ code: "custom", path: ["validTo"], message: "The end must be after the start." });
});
export type CouponInput = z.infer<typeof couponInputSchema>;

export interface CouponView {
  id: string;
  code: string;
  kind: CouponKind;
  value: number;
  maxUses: number | null;
  perCustomerLimit: number | null;
  validFrom: string | null;
  validTo: string | null;
  serviceIds: string[];
  firstVisitOnly: boolean;
  stackable: boolean;
  isActive: boolean;
  version: number;
  /** Redemptions that still count. */
  used: number;
}

/** The public check on a booking page. One answer for a wrong, expired or used-up code. */
export const validateCouponInputSchema = z.strictObject({
  clinicSlug: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(40),
  serviceId: idSchema,
});
export type ValidateCouponInput = z.infer<typeof validateCouponInputSchema>;

export type ValidateCouponResult = { valid: true; description: string; discountMinor: number; netMinor: number; currency: string } | { valid: false; message: string };

export interface OffersSummary {
  packages: PackageView[];
  plans: MembershipPlanView[];
  coupons: CouponView[];
}

/** What the customer profile and the portal show. */
export interface CustomerOffers {
  packages: CustomerPackageView[];
  memberships: CustomerMembershipView[];
}

export const useCreditInputSchema = z.strictObject({ customerPackageId: idSchema });
export const couponCodeField = couponCode;
