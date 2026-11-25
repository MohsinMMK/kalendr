import { describe, expect, it } from "vitest";

import {
  campaignInputSchema, campaignPresets, campaignSampleValues, describeRule, fillCampaignText, judgeCampaignHealth, unknownCampaignFields,
} from "./campaign-contracts";

describe("campaign wording", () => {
  it("fills known fields, blanks a missing value and leaves an unknown field as written", () => {
    expect(fillCampaignText("Hi {customer_first_name}, book: {book_link} {nope}", { customer_first_name: "Asha" })).toBe("Hi Asha, book:  {nope}");
    expect(unknownCampaignFields("{business_name} {nope} {nope} {other}")).toEqual(["nope", "other"]);
    expect(fillCampaignText("{customer_first_name}", campaignSampleValues)).toBe("Priya");
  });
});

describe("campaign input", () => {
  const base = { kind: "automated", name: "Birthday", rule: { type: "birthday" }, presetKey: null } as const;
  it("needs a subject and message for email, an approved template for WhatsApp and one short line for text", () => {
    expect(campaignInputSchema.safeParse({ ...base, channel: "email", subject: "", body: "x" }).success).toBe(false);
    expect(campaignInputSchema.safeParse({ ...base, channel: "email", subject: "Hi", body: "Hello" }).success).toBe(true);
    expect(campaignInputSchema.safeParse({ ...base, channel: "whatsapp", templateKey: "made_up" }).success).toBe(false);
    expect(campaignInputSchema.safeParse({ ...base, channel: "whatsapp", templateKey: "campaign_birthday" }).success).toBe(true);
    expect(campaignInputSchema.safeParse({ ...base, channel: "whatsapp", templateKey: "campaign_offer", body: "" }).success).toBe(false);
    expect(campaignInputSchema.safeParse({ ...base, channel: "sms", body: "line one\nline two" }).success).toBe(false);
    expect(campaignInputSchema.safeParse({ ...base, channel: "sms", body: "10% off this week" }).success).toBe(true);
  });
  it("refuses a field it does not know and a recall with no service", () => {
    expect(campaignInputSchema.safeParse({ ...base, channel: "email", subject: "Hi {secret}", body: "x" }).success).toBe(false);
    expect(campaignInputSchema.safeParse({ ...base, rule: { type: "recall", services: [] }, channel: "email", subject: "Hi", body: "x" }).success).toBe(false);
    expect(campaignInputSchema.safeParse({ ...base, rule: { type: "recall", services: [{ serviceId: "s1", intervalDays: 180 }] }, channel: "email", subject: "Hi", body: "x" }).success).toBe(true);
  });
  it("describes a recall in plain words", () => {
    expect(describeRule({ type: "recall", services: [{ serviceId: "s1", intervalDays: 180 }] }, () => "check-up")).toBe("6 months after check-up");
    expect(describeRule({ type: "win_back", daysAway: 90 })).toBe("No visit for 3 months");
  });
});

describe("ready-made campaigns", () => {
  it("ships every kind for every business type, in the business's own words", () => {
    for (const type of ["healthcare", "dental", "wellness", "real_estate", "retail"]) {
      const presets = campaignPresets(type);
      expect(presets.map((preset) => preset.ruleType)).toEqual(["recall", "birthday", "win_back", "package_expiring"]);
      for (const preset of presets) expect(unknownCampaignFields(`${preset.subject} ${preset.body}`)).toEqual([]);
    }
    expect(campaignPresets("dental")[0]).toMatchObject({ name: "6-month recall", defaultIntervalDays: 180 });
    expect(campaignPresets("wellness")[0]?.defaultIntervalDays).toBe(45);
  });
});

describe("campaign health", () => {
  it("waits for a sample, then pauses on failures first and on unsubscribes second", () => {
    expect(judgeCampaignHealth({ sent: 5, failed: 5, unsubscribed: 5 })).toEqual({ ok: true });
    expect(judgeCampaignHealth({ sent: 18, failed: 2, unsubscribed: 0 })).toEqual({ ok: true });
    expect(judgeCampaignHealth({ sent: 14, failed: 6, unsubscribed: 0 })).toEqual({ ok: false, reason: "high_failures" });
    expect(judgeCampaignHealth({ sent: 100, failed: 0, unsubscribed: 4 })).toEqual({ ok: false, reason: "high_unsubscribes" });
    expect(judgeCampaignHealth({ sent: 100, failed: 0, unsubscribed: 3 })).toEqual({ ok: true });
  });
});
