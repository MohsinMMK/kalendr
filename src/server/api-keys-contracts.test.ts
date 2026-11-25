import { describe, expect, it } from "vitest";

import { createApiKeyInput } from "./api-keys-contracts";

const day = 86_400_000;
const base = { name: "Website", mode: "live" as const, scopes: ["services:read" as const] };

describe("createApiKeyInput", () => {
  it("accepts a live key with write scopes and no expiry", () => {
    expect(createApiKeyInput.safeParse({ ...base, scopes: ["appointments:write", "customers:write"] }).success).toBe(true);
  });

  it("refuses a test key that holds a write scope, naming the scopes field", () => {
    const result = createApiKeyInput.safeParse({ ...base, mode: "test", scopes: ["services:read", "appointments:write"] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.flatten().fieldErrors.scopes?.[0]).toMatch(/test key can only read/i);
  });

  it("accepts a test key that only reads", () => {
    expect(createApiKeyInput.safeParse({ ...base, mode: "test", scopes: ["services:read", "appointments:read"] }).success).toBe(true);
  });

  it("needs a name of 1 to 80 characters and at least one known scope", () => {
    expect(createApiKeyInput.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(createApiKeyInput.safeParse({ ...base, name: "x".repeat(81) }).success).toBe(false);
    expect(createApiKeyInput.safeParse({ ...base, scopes: [] }).success).toBe(false);
    expect(createApiKeyInput.safeParse({ ...base, scopes: ["everything"] }).success).toBe(false);
  });

  it("keeps expiry in the future and within two years", () => {
    const at = (offset: number) => new Date(Date.now() + offset).toISOString();
    expect(createApiKeyInput.safeParse({ ...base, expiresAt: at(-day) }).success).toBe(false);
    expect(createApiKeyInput.safeParse({ ...base, expiresAt: at(30 * day) }).success).toBe(true);
    expect(createApiKeyInput.safeParse({ ...base, expiresAt: at(2 * 365 * day) }).success).toBe(true);
    expect(createApiKeyInput.safeParse({ ...base, expiresAt: at(3 * 365 * day) }).success).toBe(false);
    expect(createApiKeyInput.safeParse({ ...base, expiresAt: "tomorrow" }).success).toBe(false);
  });

  it("refuses unknown fields", () => {
    expect(createApiKeyInput.safeParse({ ...base, keyHash: "x" }).success).toBe(false);
  });
});
