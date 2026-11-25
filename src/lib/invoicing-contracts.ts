import { z } from "zod";

import { cleanGstin, isGstStateCode, isValidGstin, taxTreatments, type DocumentKind, type SupplyKind, type TaxTreatment } from "@/lib/gst";
import { MAX_PAYMENT_MINOR } from "@/lib/money";

/** Request and response shapes for invoices, credit notes and tax settings (feature 24), shared by the routes and the screens. */

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

const gstinField = z.string().trim().transform(cleanGstin).refine(isValidGstin, "That GSTIN does not look right. Check each character.");
const stateCodeField = z.string().refine(isGstStateCode, "Choose a state from the list.");
const sacField = z.string().trim().regex(/^\d{4,8}$/, "A HSN or SAC code is 4 to 8 digits.");

export const taxSettingsInputSchema = z.strictObject({
  registered: z.boolean(),
  gstin: gstinField.nullish(),
  legalName: z.string().trim().min(2).max(200).nullish(),
  address: z.string().trim().max(400).nullish(),
  stateCode: stateCodeField.nullish(),
  pricesIncludeTax: z.boolean(),
  defaultTreatment: z.enum(taxTreatments),
  defaultRateBps: z.number().int().min(0).max(4000),
  defaultSacCode: sacField.nullish(),
  /** The owner has checked the treatment with their accountant. */
  confirm: z.boolean().default(false),
  version: z.number().int().min(0).optional(),
}).superRefine((value, context) => {
  if (!value.registered) return;
  if (!value.gstin) context.addIssue({ code: "custom", path: ["gstin"], message: "Enter the business's GSTIN." });
  if (!value.legalName) context.addIssue({ code: "custom", path: ["legalName"], message: "Enter the name to print on invoices." });
  if (!value.stateCode) context.addIssue({ code: "custom", path: ["stateCode"], message: "Choose the state the business supplies from." });
  if (value.gstin && value.stateCode && value.gstin.slice(0, 2) !== value.stateCode) {
    context.addIssue({ code: "custom", path: ["stateCode"], message: "The state does not match the first two digits of the GSTIN." });
  }
  if (value.defaultTreatment === "taxable" && value.defaultRateBps === 0) {
    context.addIssue({ code: "custom", path: ["defaultRateBps"], message: "A taxable service needs a rate above 0%." });
  }
});
export type TaxSettingsInput = z.infer<typeof taxSettingsInputSchema>;

export const serviceTaxRuleInputSchema = z.strictObject({
  serviceId: idSchema,
  treatment: z.enum(taxTreatments),
  rateBps: z.number().int().min(0).max(4000),
  sacCode: sacField.nullish(),
}).superRefine((value, context) => {
  if (value.treatment === "taxable" && value.rateBps === 0) context.addIssue({ code: "custom", path: ["rateBps"], message: "A taxable service needs a rate above 0%." });
});
export type ServiceTaxRuleInput = z.infer<typeof serviceTaxRuleInputSchema>;

export interface TaxSettingsView {
  registered: boolean;
  gstin: string | null;
  legalName: string | null;
  address: string | null;
  stateCode: string | null;
  pricesIncludeTax: boolean;
  defaultTreatment: TaxTreatment;
  defaultRateBps: number;
  defaultSacCode: string | null;
  confirmedAt: string | null;
  /** The business has never saved these: the values are the offered defaults for its type. */
  isDefault: boolean;
  /** Why the default was offered, in plain words. */
  hint: string;
  version: number;
  services: { serviceId: string; name: string; treatment: TaxTreatment | null; rateBps: number | null; sacCode: string | null; price: number | null }[];
}

export const issueInvoiceInputSchema = z.strictObject({
  appointmentId: idSchema,
  buyerName: z.string().trim().min(1).max(200).optional(),
  buyerGstin: gstinField.optional(),
  buyerStateCode: stateCodeField.optional(),
});
export type IssueInvoiceInput = z.infer<typeof issueInvoiceInputSchema>;

export const creditNoteInputSchema = z.strictObject({
  /** Lines to credit. Leave out to credit the whole invoice. */
  lineIds: z.array(idSchema).min(1).max(50).optional(),
  reason: z.string().trim().min(2).max(200),
});
export type CreditNoteInput = z.infer<typeof creditNoteInputSchema>;

export const invoiceListQuerySchema = z.strictObject({
  patientId: idSchema.optional(),
  appointmentId: idSchema.optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  state: z.enum(["all", "due", "paid", "credited"]).default("all"),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;

export const invoiceExportQuerySchema = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  kind: z.enum(["documents", "gst-summary"]).default("documents"),
});

/** Worked out from the payments each time: an invoice row itself never changes. */
export type InvoicePayState = "unpaid" | "part_paid" | "paid" | "credited" | "refund_due";

export interface InvoiceLineView {
  id: string;
  position: number;
  description: string;
  sacCode: string | null;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  treatment: TaxTreatment;
  rateBps: number;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
  /** The credit note that already took this line back, if any. */
  creditedBy: string | null;
}

export interface CreditNoteView {
  id: string;
  number: string;
  issuedAt: string;
  reason: string;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
  lineIds: string[];
  pdfReady: boolean;
}

export interface InvoiceSummary {
  id: string;
  number: string;
  kind: DocumentKind;
  issuedAt: string;
  patientId: string;
  buyerName: string;
  appointmentId: string | null;
  source: "visit" | "package" | "membership";
  currency: string;
  totalMinor: number;
  creditedMinor: number;
  paidMinor: number;
  dueMinor: number;
  refundDueMinor: number;
  state: InvoicePayState;
}

/** A payment that counts toward an invoice, with what can still be given back from it. */
export interface InvoicePaymentView {
  id: string;
  method: "cash" | "upi" | "card" | "bank" | "other";
  amountMinor: number;
  refundableMinor: number;
  at: string;
}

export interface InvoiceView extends InvoiceSummary {
  financialYear: string;
  pricesIncludeTax: boolean;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  supply: SupplyKind | "none";
  placeOfSupplyState: string | null;
  sellerGstin: string | null;
  sellerLegalName: string;
  sellerAddress: string | null;
  sellerStateCode: string | null;
  buyerGstin: string | null;
  buyerStateCode: string | null;
  exemptionNote: string | null;
  lines: InvoiceLineView[];
  creditNotes: CreditNoteView[];
  pdfReady: boolean;
  /** The payments behind "paid", oldest first, so a refund can be given from the invoice. */
  payments: InvoicePaymentView[];
}

export interface InvoiceList {
  invoices: InvoiceSummary[];
  nextCursor: string | null;
}

export interface OutstandingBalance {
  patientId: string;
  currency: string;
  dueMinor: number;
  invoices: { id: string; number: string; dueMinor: number; issuedAt: string }[];
}

export interface InvoiceLinkResult {
  url: string;
  expiresAt: string;
}

export const invoiceLinkInputSchema = z.strictObject({ creditNoteId: idSchema.optional() });

export const maxInvoiceAmount = MAX_PAYMENT_MINOR;
