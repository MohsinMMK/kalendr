import { createCipheriv, randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLocalProvider, localMasterKeyId } from "./keys/local";
import { setKeyProviderForTests } from "./keys/provider";
import { forgetDataKeys, loadDataKeys, rotateDataKey, type DataKeyStore, type NewDataKey, type StoredDataKey } from "./keys/ring";
import { keyVersionOf, keyVersionOfText, openBytes, openText, sealBytes, sealText } from "./keys/records";

/** tenant_data_keys in memory, one list per business, as RLS would scope it. */
function memoryStore(): DataKeyStore & { rows: Map<string, StoredDataKey[]> } {
  const rows = new Map<string, StoredDataKey[]>();
  return {
    rows,
    async list(tenantId) {
      return [...(rows.get(tenantId) ?? [])].sort((a, b) => a.version - b.version);
    },
    async insert(tenantId, key: NewDataKey) {
      const list = rows.get(tenantId) ?? [];
      if (list.some((row) => row.version === key.version)) return false;
      list.push({
        version: key.version,
        provider: key.provider,
        wrappedKey: key.wrappedKey,
        masterKeyId: key.masterKeyId,
        createdAt: new Date(),
        retiredAt: key.retired ? new Date() : null,
      });
      rows.set(tenantId, list);
      return true;
    },
  };
}

/** A record sealed the way every record was before feature 10: "v1", the server-wide key, the business id as AAD. */
function legacySeal(key: Buffer, tenantId: string, plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(tenantId));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v1"), iv, cipher.getAuthTag(), body]);
}

const legacyKey = randomBytes(32);
let store: ReturnType<typeof memoryStore>;

beforeEach(() => {
  vi.stubEnv("KALENDR_RECORDS_KEY", legacyKey.toString("base64"));
  setKeyProviderForTests("local", createLocalProvider(randomBytes(32)));
  forgetDataKeys();
  store = memoryStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  setKeyProviderForTests("local", undefined);
  forgetDataKeys();
});

describe("record encryption", () => {
  it("round-trips text and bytes under the business's first key, and never stores the plain value", async () => {
    expect(await loadDataKeys(store, "clinic_a", { forWrite: true })).toBe(1);
    const sealed = sealText("clinic_a", "Blood pressure note");
    expect(sealed).not.toContain("Blood");
    expect(keyVersionOfText(sealed)).toBe(1);
    expect(openText("clinic_a", sealed)).toBe("Blood pressure note");
    const bytes = randomBytes(1_024);
    const sealedBytes = sealBytes("clinic_a", bytes);
    expect(keyVersionOf(sealedBytes)).toBe(1);
    expect(openBytes("clinic_a", sealedBytes).equals(bytes)).toBe(true);
  });

  it("stores only the wrapped key", async () => {
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    const [row] = store.rows.get("clinic_a")!;
    expect(row!.provider).toBe("local");
    expect(row!.wrappedKey!.length).toBeGreaterThan(32);
    expect(row!.masterKeyId).toMatch(/^local:[0-9a-f]{16}$/);
  });

  it("refuses to seal before the business's keys are loaded for writing", async () => {
    expect(() => sealText("clinic_a", "x")).toThrow(/not loaded/);
    await loadDataKeys(store, "clinic_a");
    expect(() => sealText("clinic_a", "x")).toThrow(/not loaded/);
  });

  it("keeps businesses apart: own keys, and a ciphertext copied across won't open", async () => {
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    await loadDataKeys(store, "clinic_b", { forWrite: true });
    expect(store.rows.get("clinic_a")![0]!.wrappedKey!.equals(store.rows.get("clinic_b")![0]!.wrappedKey!)).toBe(false);
    expect(() => openText("clinic_b", sealText("clinic_a", "private"))).toThrow();
  });

  it("won't unwrap a business's key moved to another business's row", async () => {
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    store.rows.set("clinic_b", store.rows.get("clinic_a")!.map((row) => ({ ...row })));
    await expect(loadDataKeys(store, "clinic_b")).rejects.toThrow();
  });

  it("detects tampering, including a changed version number", async () => {
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    await rotateDataKey(store, "clinic_a");
    const sealed = sealBytes("clinic_a", Buffer.from("private"));
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1]! ^= 0xff;
    expect(() => openBytes("clinic_a", flipped)).toThrow();
    const relabelled = Buffer.from(sealed);
    relabelled.writeUInt32BE(1, 2);
    expect(() => openBytes("clinic_a", relabelled)).toThrow();
  });

  it("uses a fresh nonce each time", async () => {
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    expect(sealText("clinic_a", "same")).not.toBe(sealText("clinic_a", "same"));
  });

  it("still opens records written before per-business keys (version 0)", async () => {
    const old = legacySeal(legacyKey, "clinic_a", "Written last year");
    expect(keyVersionOf(old)).toBe(0);
    expect(openBytes("clinic_a", old).toString("utf8")).toBe("Written last year");
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    expect(openBytes("clinic_a", old).toString("utf8")).toBe("Written last year");
    expect(keyVersionOfText(sealText("clinic_a", "new"))).toBe(1);
    expect(() => openBytes("clinic_b", old)).toThrow();
  });

  it("after rotation, writes use the new key and old and new records both open", async () => {
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    const before = sealText("clinic_a", "first key");
    expect(await rotateDataKey(store, "clinic_a")).toBe(2);
    const after = sealText("clinic_a", "second key");
    expect(keyVersionOfText(after)).toBe(2);
    expect(openText("clinic_a", before)).toBe("first key");
    expect(openText("clinic_a", after)).toBe("second key");
  });

  it("a rotation by another process is picked up on the next load, without a restart", async () => {
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    const other = memoryStore();
    other.rows.set("clinic_a", store.rows.get("clinic_a")!);
    await rotateDataKey(other, "clinic_a");
    forgetDataKeys("clinic_a");
    expect(await loadDataKeys(store, "clinic_a", { forWrite: true })).toBe(2);
  });

  it("a retired version still opens; once the old server-wide key is retired it is refused", async () => {
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    const v1 = sealText("clinic_a", "on key 1");
    await rotateDataKey(store, "clinic_a");
    store.rows.get("clinic_a")!.find((row) => row.version === 1)!.retiredAt = new Date();
    expect(await loadDataKeys(store, "clinic_a", { forWrite: true })).toBe(2);
    expect(openText("clinic_a", v1)).toBe("on key 1");

    const old = legacySeal(legacyKey, "clinic_a", "legacy");
    await store.insert("clinic_a", { version: 0, provider: "legacy", wrappedKey: null, masterKeyId: null, retired: true });
    await loadDataKeys(store, "clinic_a");
    expect(() => openBytes("clinic_a", old)).toThrow(/no longer accepts/);
  });

  it("makes one key when two writers race for a business's first key", async () => {
    const [a, b] = await Promise.all([
      loadDataKeys(store, "clinic_a", { forWrite: true }),
      loadDataKeys(store, "clinic_a", { forWrite: true }),
    ]);
    expect([a, b]).toEqual([1, 1]);
    expect(store.rows.get("clinic_a")).toHaveLength(1);
  });

  it("names the wrong master key instead of returning garbage", async () => {
    await loadDataKeys(store, "clinic_a", { forWrite: true });
    const otherMaster = randomBytes(32);
    setKeyProviderForTests("local", createLocalProvider(otherMaster));
    forgetDataKeys();
    await expect(loadDataKeys(store, "clinic_a")).rejects.toThrow(/different local master key/);
    expect(localMasterKeyId(otherMaster)).not.toBe(store.rows.get("clinic_a")![0]!.masterKeyId);
  });

  it("fails closed in production without keys, and rejects a key of the wrong length", async () => {
    setKeyProviderForTests("local", undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KALENDR_KEY_PROVIDER", "");
    await expect(loadDataKeys(store, "clinic_a", { forWrite: true })).rejects.toThrow(/not set up/);
    vi.stubEnv("KALENDR_RECORDS_KEY", "");
    expect(() => openBytes("clinic_a", legacySeal(legacyKey, "clinic_a", "x"))).toThrow(/not set up/);
    vi.stubEnv("KALENDR_RECORDS_KEY", Buffer.from("short").toString("base64"));
    expect(() => openBytes("clinic_a", legacySeal(legacyKey, "clinic_a", "x"))).toThrow(/not set up/);
  });
});
