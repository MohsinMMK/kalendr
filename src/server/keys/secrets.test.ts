import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLocalProvider } from "./local";
import { setKeyProviderForTests } from "./provider";
import { forgetDataKeys, loadDataKeys, rotateDataKey, type DataKeyStore, type StoredDataKey } from "./ring";
import { openSecret, sealSecret, secretKeyVersion } from "./secrets";

function memoryStore(): DataKeyStore {
  const rows: Record<string, StoredDataKey[]> = {};
  return {
    async list(tenantId) {
      return rows[tenantId] ?? [];
    },
    async insert(tenantId, key) {
      const list = (rows[tenantId] ??= []);
      if (list.some((row) => row.version === key.version)) return false;
      list.push({ ...key, createdAt: new Date(), retiredAt: key.retired ? new Date() : null });
      return true;
    },
  };
}

let store: DataKeyStore;
beforeEach(() => {
  setKeyProviderForTests("local", createLocalProvider(randomBytes(32)));
  forgetDataKeys();
  store = memoryStore();
});
afterEach(() => {
  setKeyProviderForTests("local", undefined);
  forgetDataKeys();
});

describe("secrets for other features", () => {
  it("round-trips, records the key version, and survives rotation", async () => {
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    const sealed = sealSecret("clinic_a", "calendar.google.refresh-token", "1//token-value");
    expect(sealed.startsWith("s1.")).toBe(true);
    expect(sealed).not.toContain("token-value");
    expect(secretKeyVersion(sealed)).toBe(1);
    await rotateDataKey(store, "clinic_a");
    expect(openSecret("clinic_a", "calendar.google.refresh-token", sealed)).toBe("1//token-value");
    expect(secretKeyVersion(sealSecret("clinic_a", "calendar.google.refresh-token", "x"))).toBe(2);
  });

  it("is bound to its purpose and its business", async () => {
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    await loadDataKeys(store, "clinic_b", { forWrite: true });
    const sealed = sealSecret("clinic_a", "payments.razorpay.key-secret", "secret");
    expect(() => openSecret("clinic_a", "payments.razorpay.webhook-secret", sealed)).toThrow();
    expect(() => openSecret("clinic_b", "payments.razorpay.key-secret", sealed)).toThrow();
  });

  it("never uses the old server-wide key, and rejects odd purposes and formats", async () => {
    expect(() => sealSecret("clinic_a", "x", "secret")).toThrow();
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    expect(() => sealSecret("clinic_a", "Bad Purpose", "secret")).toThrow(/purpose/);
    expect(() => openSecret("clinic_a", "x", "plain-text")).toThrow(/format/);
  });
});
