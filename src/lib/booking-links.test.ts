import { describe, expect, it } from "vitest";

import { bookingLinkInputSchema, bookingLinkPath, shortCodePattern, SHORT_CODE_ALPHABET } from "./booking-links";

describe("short link addresses", () => {
  it("opens the business page or one service, with campaign tags and prefill", () => {
    const base = bookingLinkInputSchema.parse({ label: "Card" });
    expect(bookingLinkPath("lotus-dental", base)).toBe("/book/lotus-dental");
    const tagged = bookingLinkInputSchema.parse({ label: "Card", serviceSlug: "cleaning", utmSource: "instagram", utmCampaign: "diwali offer", prefill: { name: "A&B" } });
    expect(bookingLinkPath("lotus-dental", tagged)).toBe("/book/lotus-dental/cleaning?utm_source=instagram&utm_campaign=diwali+offer&name=A%26B");
  });
  it("can never lead off the business's own booking pages", () => {
    expect(bookingLinkInputSchema.safeParse({ label: "x", serviceSlug: "../../admin" }).success).toBe(false);
    expect(bookingLinkInputSchema.safeParse({ label: "x", utmSource: "a&utm_x=<b>" }).success).toBe(false);
    expect(bookingLinkInputSchema.safeParse({ label: "" }).success).toBe(false);
    expect(bookingLinkInputSchema.safeParse({ label: "x", prefill: { name: "n", evil: "y" } }).success).toBe(false);
    expect(Object.keys(bookingLinkInputSchema.parse({ label: "x", prefill: { name: "n" } }).prefill)).toEqual(["name"]);
  });
  it("makes codes of seven readable characters that the database accepts", () => {
    expect(SHORT_CODE_ALPHABET).not.toMatch(/[ilo01]/);
    expect(shortCodePattern.test("abc2345")).toBe(true);
    expect(shortCodePattern.test("abc234")).toBe(false);
    expect(shortCodePattern.test("ABC2345")).toBe(false);
    expect([...SHORT_CODE_ALPHABET].every((char) => shortCodePattern.test(char.repeat(7)))).toBe(true);
  });
});
