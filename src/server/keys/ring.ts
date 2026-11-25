/**
 * Each business's unwrapped data keys, cached in this process.
 *
 * The seal and open functions stay synchronous, so callers first load the business's keys
 * inside their own transaction (loadDataKeys). Loading reads tenant_data_keys every time,
 * which is one small indexed read, and unwraps only versions this process has not seen, so
 * a rotation done by the worker is picked up on the next request without any restart.
 *
 * Version 0 is KALENDR_RECORDS_KEY and needs no row. Versions 1+ are per business.
 */
import { legacyRecordsKey } from "./envelope";
import { configuredKeyProvider, keyProviderNamed, type KeyProviderName } from "./provider";

export type StoredKeyProvider = "legacy" | KeyProviderName;

export interface StoredDataKey {
  version: number;
  provider: StoredKeyProvider;
  wrappedKey: Buffer | null;
  masterKeyId: string | null;
  createdAt: Date;
  retiredAt: Date | null;
}

export interface NewDataKey {
  version: number;
  provider: StoredKeyProvider;
  wrappedKey: Buffer | null;
  masterKeyId: string | null;
  retired?: boolean;
}

/** Reads and writes tenant_data_keys inside a transaction already scoped to the business. */
export interface DataKeyStore {
  list(tenantId: string): Promise<StoredDataKey[]>;
  /** Inserts unless that version already exists. True when this call inserted it. */
  insert(tenantId: string, key: NewDataKey): Promise<boolean>;
}

interface CachedKey {
  key: Buffer;
  wrapped: string;
}

interface Ring {
  current: number;
  keys: Map<number, CachedKey>;
  /** Every version-0 record has been moved to the business's own key, and the old key is refused. */
  legacyRetired: boolean;
}

const rings = new Map<string, Ring>();

async function unwrapRows(tenantId: string, rows: StoredDataKey[]): Promise<Ring> {
  const previous = rings.get(tenantId);
  const keys = new Map<number, CachedKey>();
  let current = 0;
  const legacyRetired = rows.some((row) => row.version === 0 && row.retiredAt !== null);
  for (const row of rows) {
    if (row.version === 0 || !row.wrappedKey || !row.masterKeyId || row.provider === "legacy") continue;
    const wrapped = row.wrappedKey.toString("base64");
    const known = previous?.keys.get(row.version);
    if (known && known.wrapped === wrapped) {
      keys.set(row.version, known);
    } else {
      const key = await keyProviderNamed(row.provider).unwrapDataKey(
        { tenantId, version: row.version },
        row.wrappedKey,
        row.masterKeyId,
      );
      keys.set(row.version, { key, wrapped });
    }
    if (row.retiredAt === null && row.version > current) current = row.version;
  }
  return { current, keys, legacyRetired };
}

/** Makes the next key version for a business. Two callers racing make one version; both see it. */
async function createNextVersion(store: DataKeyStore, tenantId: string, rows: StoredDataKey[]): Promise<void> {
  const version = Math.max(0, ...rows.map((row) => row.version)) + 1;
  const provider = configuredKeyProvider();
  const generated = await provider.generateDataKey({ tenantId, version });
  await store.insert(tenantId, {
    version,
    provider: provider.name,
    wrappedKey: generated.wrapped,
    masterKeyId: generated.masterKeyId,
  });
}

/**
 * Loads a business's data keys into this process. With forWrite, a business that has no key
 * yet gets version 1 first, so new writes never use the old server-wide key.
 * Returns the version new writes will use.
 */
export async function loadDataKeys(
  store: DataKeyStore,
  tenantId: string,
  options: { forWrite?: boolean } = {},
): Promise<number> {
  let rows = await store.list(tenantId);
  if (options.forWrite && !rows.some((row) => row.version > 0 && row.retiredAt === null)) {
    await createNextVersion(store, tenantId, rows);
    rows = await store.list(tenantId);
  }
  const ring = await unwrapRows(tenantId, rows);
  rings.set(tenantId, ring);
  return ring.current;
}

/** Adds a new key version for a business and makes it the one new writes use. Returns it. */
export async function rotateDataKey(store: DataKeyStore, tenantId: string): Promise<number> {
  await createNextVersion(store, tenantId, await store.list(tenantId));
  return loadDataKeys(store, tenantId);
}

function notLoaded(): Error {
  return new Error("This business's data keys were not loaded before use");
}

/** The version new ciphertext is sealed with. Needs loadDataKeys({ forWrite: true }) first. */
export function currentKeyVersion(tenantId: string): number {
  const ring = rings.get(tenantId);
  if (!ring || ring.current === 0) throw notLoaded();
  return ring.current;
}

/** The key for one version. Version 0 is the server-wide key and needs no loading. */
export function dataKeyFor(tenantId: string, version: number): Buffer {
  if (version === 0) {
    if (rings.get(tenantId)?.legacyRetired) throw new Error("This business no longer accepts the old server-wide key");
    return legacyRecordsKey();
  }
  const cached = rings.get(tenantId)?.keys.get(version);
  if (!cached) throw notLoaded();
  return cached.key;
}

/** Tests start from an empty cache. */
export function forgetDataKeys(tenantId?: string): void {
  if (tenantId) rings.delete(tenantId);
  else rings.clear();
}
