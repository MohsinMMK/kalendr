/**
 * Money is kept as whole numbers in the currency's smallest unit (paise for INR), never as floats.
 */

/** Largest amount one payment can be: ₹1 crore. Keeps typos like an extra zero or two out. */
export const MAX_PAYMENT_MINOR = 1_00_00_000_00;

const exactPrice = /^(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})*|\d+)(?:\.(\d{1,2}))?\s*(?:\/-)?$/i;

/**
 * The amount a price text stands for, when it is one exact price such as "₹800" or "Rs. 1,200".
 * Text such as "From ₹1,500" or "Free consultation" has no single price and gives null.
 */
export function priceFromLabel(label: string | null | undefined): number | null {
  const match = exactPrice.exec(label?.trim() ?? "");
  if (!match) return null;
  const rupees = Number(match[1]!.replaceAll(",", ""));
  const paise = Number((match[2] ?? "").padEnd(2, "0") || 0);
  const minor = rupees * 100 + paise;
  return Number.isSafeInteger(minor) && minor <= MAX_PAYMENT_MINOR ? minor : null;
}

/** "₹1,200" or "₹1,200.50": paise only when there are some. */
export function formatMoney(minor: number, currency = "INR", locale = "en-IN"): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(minor / 100);
}

/** What the desk types ("800", "1,200.5") as paise, or null when it is not an amount. */
export function parseAmountInput(value: string): number | null {
  const cleaned = value.trim().replace(/^₹\s*/, "").replaceAll(",", "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const [rupees, paise = ""] = cleaned.split(".");
  const minor = Number(rupees) * 100 + Number(paise.padEnd(2, "0"));
  return minor > 0 && minor <= MAX_PAYMENT_MINOR ? minor : null;
}

/** Paise as the plain number the amount field shows: 80000 → "800", 80050 → "800.50". */
export function amountInputValue(minor: number): string {
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
}

export type PaymentState = "unpriced" | "unpaid" | "part_paid" | "paid" | "refunded";

export interface VisitBalance {
  state: PaymentState;
  priceMinor: number | null;
  /** Paid minus refunded. */
  netPaidMinor: number;
  dueMinor: number;
}

/** Where a visit stands: what it costs, what has been paid net of refunds, and what is still due. */
export function visitBalance(priceMinor: number | null | undefined, paidMinor = 0, refundedMinor = 0): VisitBalance {
  // A free visit (0) has nothing to collect, same as one with no set price.
  const price = priceMinor ? priceMinor : null;
  const netPaidMinor = Math.max(0, paidMinor - refundedMinor);
  const dueMinor = price === null ? 0 : Math.max(0, price - netPaidMinor);
  let state: PaymentState;
  if (paidMinor > 0 && netPaidMinor === 0) state = "refunded";
  else if (price === null) state = netPaidMinor > 0 ? "paid" : "unpriced";
  else if (dueMinor === 0) state = "paid";
  else state = netPaidMinor > 0 ? "part_paid" : "unpaid";
  return { state, priceMinor: price, netPaidMinor, dueMinor };
}
