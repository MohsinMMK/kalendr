/**
 * GST rules for a business's invoices to its own customers (feature 24). Pure functions, no database, so the same code
 * runs in the issuing transaction, the live preview on screen and the tests.
 *
 * This is not Kalendr's own subscription invoicing (see `billing-rules.ts`). Nothing here decides a business's tax
 * treatment: `defaultTaxFor` only offers a starting point, the owner confirms it, and the screen tells them to check
 * it with their accountant. All amounts are whole paise.
 */

export const taxTreatments = ["taxable", "exempt", "nil"] as const;
export type TaxTreatment = (typeof taxTreatments)[number];

/** What the document is called. Not registered: a receipt. Registered but nothing taxable: a bill of supply. */
export type DocumentKind = "tax_invoice" | "bill_of_supply" | "receipt";

export const documentTitles: Record<DocumentKind, string> = {
  tax_invoice: "Tax invoice",
  bill_of_supply: "Bill of supply",
  receipt: "Receipt",
};

/** GST state and union territory codes: the first two digits of a GSTIN. Code 25 was merged into 26 in 2020. */
export const gstStates: readonly { code: string; name: string; /** Union territory without a legislature: the state half of the tax is UTGST. */ utgst?: true }[] = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh", utgst: true },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu", utgst: true },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep", utgst: true },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands", utgst: true },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh", utgst: true },
];

export function gstStateName(code: string | null | undefined): string | null {
  return gstStates.find((state) => state.code === code)?.name ?? null;
}

export function isGstStateCode(code: string): boolean {
  return gstStates.some((state) => state.code === code);
}

/** "SGST", or "UTGST" for a union territory without a legislature. */
export function stateTaxLabel(stateCode: string | null | undefined): "SGST" | "UTGST" {
  return gstStates.find((state) => state.code === stateCode)?.utgst ? "UTGST" : "SGST";
}

const gstinAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const gstinShape = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Upper-cases and strips spaces, so " 36aabcu9603r1zm " compares equal to the registered number. */
export function cleanGstin(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** The check character the government's GSTIN algorithm puts last (mod 36 over the first fourteen). */
function gstinCheckCharacter(first14: string): string {
  let sum = 0;
  for (let index = 0; index < 14; index++) {
    const value = gstinAlphabet.indexOf(first14[index]!);
    const product = value * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return gstinAlphabet[(36 - (sum % 36)) % 36]!;
}

/** Whether a GSTIN has the right shape, a real state code and a matching check character. */
export function isValidGstin(value: string): boolean {
  const gstin = cleanGstin(value);
  const match = gstinShape.exec(gstin);
  if (!match || !isGstStateCode(match[1]!)) return false;
  return gstinCheckCharacter(gstin.slice(0, 14)) === gstin[14];
}

export function gstinStateCode(gstin: string): string {
  return cleanGstin(gstin).slice(0, 2);
}

// --- Supply ------------------------------------------------------------------------------------------------------

export type SupplyKind = "intra" | "inter";

/**
 * Where the supply is deemed to happen. A buyer with a GSTIN is taxed by that registration's state; otherwise the
 * state the desk picked; otherwise the business's own (a walk-in customer, supplied where the business is).
 */
export function placeOfSupply(input: { supplierStateCode: string; buyerGstin?: string | null; buyerStateCode?: string | null }): { stateCode: string; supply: SupplyKind } {
  const fromGstin = input.buyerGstin ? gstinStateCode(input.buyerGstin) : null;
  const stateCode = fromGstin ?? input.buyerStateCode ?? input.supplierStateCode;
  return { stateCode, supply: stateCode === input.supplierStateCode ? "intra" : "inter" };
}

// --- Tax ---------------------------------------------------------------------------------------------------------

export interface TaxLineInput {
  description: string;
  /** HSN for goods, SAC for services. Kept on the invoice as written. */
  sacCode: string | null;
  quantity: number;
  /** What one unit costs as entered, before any discount. */
  unitPriceMinor: number;
  /** Total discount on this line, before tax. */
  discountMinor: number;
  treatment: TaxTreatment;
  /** Percent × 100: 1800 is 18%. Ignored unless the line is taxable. */
  rateBps: number;
}

export interface TaxContext {
  /** Whether the business is registered for GST. Not registered means no tax on anything. */
  registered: boolean;
  /** Prices are what the customer pays (tax inside) rather than before tax. */
  pricesIncludeTax: boolean;
  supply: SupplyKind;
}

export interface TaxedLine extends TaxLineInput {
  /** `quantity × unit price − discount`: what was entered, after the discount. */
  netEnteredMinor: number;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  /** What the customer owes for this line: taxable value plus its tax. */
  totalMinor: number;
  /** The treatment actually applied: a business that is not registered charges no tax whatever the service says. */
  appliedTreatment: TaxTreatment;
  appliedRateBps: number;
}

export interface TaxTotals {
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
}

export interface TaxedInvoice {
  lines: TaxedLine[];
  totals: TaxTotals;
  kind: DocumentKind;
}

/** Whole paise, halves rounded up. Inputs stay far below 2^53 (₹1 crore × 40% is 4×10^11). */
function divideRounded(numerator: number, denominator: number): number {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

export class GstInputError extends Error {}

export function taxLine(input: TaxLineInput, context: TaxContext): TaxedLine {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) throw new GstInputError("Quantity must be a whole number of at least 1.");
  if (!Number.isInteger(input.unitPriceMinor) || input.unitPriceMinor < 0) throw new GstInputError("Price must be a whole number of paise.");
  if (!Number.isInteger(input.discountMinor) || input.discountMinor < 0) throw new GstInputError("Discount must be a whole number of paise.");
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 4000) throw new GstInputError("Tax rate must be between 0% and 40%.");
  const list = input.quantity * input.unitPriceMinor;
  if (input.discountMinor > list) throw new GstInputError("A discount cannot be more than the price.");
  const net = list - input.discountMinor;

  const charged = context.registered && input.treatment === "taxable" && input.rateBps > 0;
  const appliedTreatment: TaxTreatment = context.registered ? input.treatment : "nil";
  const appliedRateBps = charged ? input.rateBps : 0;
  let taxable = net;
  let tax = 0;
  if (charged) {
    if (context.pricesIncludeTax) {
      // The customer pays `net` whatever the rate is, so tax is carved out of it and the total never moves.
      tax = divideRounded(net * input.rateBps, 10_000 + input.rateBps);
      taxable = net - tax;
    } else {
      tax = divideRounded(net * input.rateBps, 10_000);
    }
  }
  // An odd paisa goes to the state half, so CGST + SGST always equals the tax exactly.
  const cgst = context.supply === "intra" ? Math.floor(tax / 2) : 0;
  const sgst = context.supply === "intra" ? tax - cgst : 0;
  const igst = context.supply === "inter" ? tax : 0;
  return {
    ...input,
    netEnteredMinor: net,
    taxableMinor: taxable,
    cgstMinor: cgst,
    sgstMinor: sgst,
    igstMinor: igst,
    totalMinor: taxable + tax,
    appliedTreatment,
    appliedRateBps,
  };
}

export function sumTax(lines: readonly Pick<TaxedLine, "taxableMinor" | "cgstMinor" | "sgstMinor" | "igstMinor" | "totalMinor">[]): TaxTotals {
  return lines.reduce<TaxTotals>((sum, line) => ({
    taxableMinor: sum.taxableMinor + line.taxableMinor,
    cgstMinor: sum.cgstMinor + line.cgstMinor,
    sgstMinor: sum.sgstMinor + line.sgstMinor,
    igstMinor: sum.igstMinor + line.igstMinor,
    totalMinor: sum.totalMinor + line.totalMinor,
  }), { taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 0 });
}

export function documentKind(registered: boolean, lines: readonly Pick<TaxedLine, "cgstMinor" | "sgstMinor" | "igstMinor" | "appliedTreatment" | "appliedRateBps">[]): DocumentKind {
  if (!registered) return "receipt";
  return lines.some((line) => line.appliedTreatment === "taxable" && line.appliedRateBps > 0) ? "tax_invoice" : "bill_of_supply";
}

/** Tax for a whole invoice. Rounding is per line, in paise, then summed: the totals are the sum of the printed lines. */
export function taxInvoice(lines: readonly TaxLineInput[], context: TaxContext): TaxedInvoice {
  const taxed = lines.map((line) => taxLine(line, context));
  return { lines: taxed, totals: sumTax(taxed), kind: documentKind(context.registered, taxed) };
}

// --- Defaults by business type -----------------------------------------------------------------------------------

export interface TaxDefault {
  treatment: TaxTreatment;
  rateBps: number;
  sacCode: string | null;
  /** Shown beside the exemption on the invoice. */
  exemptionNote: string | null;
  /** Plain words for the settings screen: why this is offered, and what to confirm. */
  hint: string;
}

export const HEALTH_EXEMPTION_NOTE = "Exempt: healthcare services by a clinical establishment (Notification 12/2017-CT(Rate), entry 74).";

/**
 * A starting point, never a decision. Healthcare is offered as exempt, everything else at 18% (the usual rate for
 * services). The owner sets it per service and confirms it with their accountant.
 */
export function defaultTaxFor(businessType: string): TaxDefault {
  switch (businessType) {
    case "healthcare":
    case "dental":
      return { treatment: "exempt", rateBps: 0, sacCode: "999312", exemptionNote: HEALTH_EXEMPTION_NOTE, hint: "Healthcare services by a clinic are usually exempt from GST. Confirm this applies to you." };
    case "wellness":
      return { treatment: "taxable", rateBps: 1800, sacCode: "999722", exemptionNote: null, hint: "Salon, spa and fitness services are usually taxed at 18%. Confirm the rate for each service." };
    case "education":
      return { treatment: "taxable", rateBps: 1800, sacCode: "999293", exemptionNote: null, hint: "Some education is exempt and some is taxed. Check each service with your accountant." };
    default:
      return { treatment: "taxable", rateBps: 1800, sacCode: null, exemptionNote: null, hint: "Services are usually taxed at 18%. Confirm the rate with your accountant." };
  }
}

// --- Financial year and numbering --------------------------------------------------------------------------------

/**
 * The Indian financial year (April to March) a moment falls in, by the business's own calendar: "2026-27".
 * The clock in the business's time zone decides, so a visit at 11pm IST on 31 March is still the old year.
 */
export function financialYearOf(moment: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "numeric" }).formatToParts(moment);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** First and last calendar day of a financial year, as dates ("2026-04-01", "2027-03-31"). */
export function financialYearBounds(financialYear: string): { from: string; to: string } {
  const start = Number(financialYear.slice(0, 4));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

export const DEFAULT_SERIES = "INV";
export const CREDIT_NOTE_SERIES = "CN";

/**
 * "2026-27/0001" for the default series, "CN/2026-27/0001" for others. GST allows at most 16 characters, and this
 * stays inside that for any series of up to four letters.
 */
export function formatInvoiceNumber(series: string, financialYear: string, sequence: number): string {
  const body = `${financialYear}/${String(sequence).padStart(4, "0")}`;
  return series === DEFAULT_SERIES ? body : `${series}/${body}`;
}
