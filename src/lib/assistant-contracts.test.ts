import { describe, expect, it } from "vitest";

import { assistantChatRequestSchema, assistantSettingsSchema, assistantSettingsUpdateSchema } from "./assistant-contracts";

const token = "a".repeat(43);

describe("a visitor's request", () => {
  it("is one thing at a time: a message, a tapped Confirm or a code", () => {
    expect(assistantChatRequestSchema.safeParse({ business: "lotus-dental", text: "hello" }).success).toBe(true);
    expect(assistantChatRequestSchema.safeParse({ business: "lotus-dental", token, confirmProposalId: "A".repeat(32) }).success).toBe(true);
    expect(assistantChatRequestSchema.safeParse({ business: "lotus-dental", token, code: "123456" }).success).toBe(true);
    expect(assistantChatRequestSchema.safeParse({ business: "lotus-dental", text: "hi", code: "123456" }).success).toBe(false);
    expect(assistantChatRequestSchema.safeParse({ business: "lotus-dental" }).success).toBe(false);
  });
  it("refuses a bad business name, token, code or an oversized message", () => {
    expect(assistantChatRequestSchema.safeParse({ business: "Lotus Dental!", text: "hi" }).success).toBe(false);
    expect(assistantChatRequestSchema.safeParse({ business: "lotus-dental", token: "short", text: "hi" }).success).toBe(false);
    expect(assistantChatRequestSchema.safeParse({ business: "lotus-dental", token, code: "12345" }).success).toBe(false);
    expect(assistantChatRequestSchema.safeParse({ business: "lotus-dental", text: "x".repeat(1001) }).success).toBe(false);
    expect(assistantChatRequestSchema.safeParse({ business: "lotus-dental", text: "hi", tenantId: "other" }).success).toBe(true);
  });
  it("carries no tenant: an extra field is dropped, never read", () => {
    const parsed = assistantChatRequestSchema.parse({ business: "lotus-dental", text: "hi", tenantId: "other" });
    expect("tenantId" in parsed).toBe(false);
  });
});

describe("the owner's settings", () => {
  const valid = { enabledWeb: true, enabledWhatsapp: false, enabledSms: false, tone: "friendly", handoffRule: "balanced", businessFacts: "We close at 6.", retentionDays: 90 };
  it("accepts a normal save and carries the version a screen loaded", () => {
    expect(assistantSettingsSchema.safeParse(valid).success).toBe(true);
    expect(assistantSettingsUpdateSchema.safeParse({ ...valid, version: 3 }).success).toBe(true);
    expect(assistantSettingsUpdateSchema.safeParse(valid).success).toBe(false);
  });
  it("keeps words and retention in range", () => {
    expect(assistantSettingsSchema.safeParse({ ...valid, tone: "angry" }).success).toBe(false);
    expect(assistantSettingsSchema.safeParse({ ...valid, retentionDays: 1 }).success).toBe(false);
    expect(assistantSettingsSchema.safeParse({ ...valid, businessFacts: "x".repeat(3001) }).success).toBe(false);
  });
});
