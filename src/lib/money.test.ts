import { describe, expect, it } from "vitest";

import { amountInputValue, formatMoney, parseAmountInput, priceFromLabel, visitBalance } from "./money";

describe("money", () => {
  it("reads one exact price from price text, and nothing from a range or words", () => {
    expect(priceFromLabel("₹800")).toBe(80_000);
    expect(priceFromLabel("Rs. 1,200")).toBe(1_20_000);
    expect(priceFromLabel("₹1,50,000")).toBe(1_50_00_000);
    expect(priceFromLabel("INR 499.50")).toBe(49_950);
    expect(priceFromLabel("From ₹1,500")).toBeNull();
    expect(priceFromLabel("Free consultation")).toBeNull();
    expect(priceFromLabel("")).toBeNull();
    expect(priceFromLabel(null)).toBeNull();
  });

  it("reads what the desk types as paise and refuses anything else", () => {
    expect(parseAmountInput("800")).toBe(80_000);
    expect(parseAmountInput("₹1,200.5")).toBe(1_20_050);
    expect(parseAmountInput("0")).toBeNull();
    expect(parseAmountInput("-5")).toBeNull();
    expect(parseAmountInput("12.345")).toBeNull();
    expect(parseAmountInput("abc")).toBeNull();
    expect(parseAmountInput("100000001")).toBeNull();
  });

  it("shows paise only when there are some", () => {
    expect(formatMoney(1_20_000)).toBe("₹1,200");
    expect(formatMoney(1_20_050)).toBe("₹1,200.50");
    expect(amountInputValue(80_000)).toBe("800");
    expect(amountInputValue(80_050)).toBe("800.50");
  });

  it("works out what is still due, net of refunds", () => {
    expect(visitBalance(80_000)).toEqual({ state: "unpaid", priceMinor: 80_000, netPaidMinor: 0, dueMinor: 80_000 });
    expect(visitBalance(80_000, 50_000)).toMatchObject({ state: "part_paid", dueMinor: 30_000 });
    expect(visitBalance(80_000, 80_000)).toMatchObject({ state: "paid", dueMinor: 0 });
    expect(visitBalance(80_000, 80_000, 20_000)).toMatchObject({ state: "part_paid", netPaidMinor: 60_000, dueMinor: 20_000 });
    expect(visitBalance(80_000, 80_000, 80_000)).toMatchObject({ state: "refunded", dueMinor: 80_000 });
  });

  it("treats a visit with no price, or a free one, as nothing to collect", () => {
    expect(visitBalance(null)).toMatchObject({ state: "unpriced", dueMinor: 0 });
    expect(visitBalance(0)).toMatchObject({ state: "unpriced", priceMinor: null });
    expect(visitBalance(undefined, 30_000)).toMatchObject({ state: "paid", netPaidMinor: 30_000, dueMinor: 0 });
  });
});
