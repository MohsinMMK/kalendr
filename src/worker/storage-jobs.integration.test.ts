/** @vitest-environment node */

import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FileStore } from "../server/file-store";
import { fileStoreKey } from "../server/file-store-keys";
import { legacyRecordsKey } from "../server/keys/envelope";
import { postgresDataKeyStore } from "../server/keys/postgres-store";
import { keyVersionOf, keyVersionOfText, openBytes, openText, sealBytes } from "../server/keys/records";
import { forgetDataKeys, loadDataKeys } from "../server/keys/ring";
import type { Scanner } from "../server/scan/clamav";
import { fileRemoveHandler, scanFileHandler } from "./handlers/scan-file";
import type { OutboxEvent } from "./handlers/types";
import { backfillTenantMedia, reEncryptTenant, rotateDueKeys, rotateTenantKey, storageHealth } from "./storage-jobs";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

/** A bucket in memory that keeps every version written, like a versioned S3 bucket. */
function memoryStore(): FileStore & { versions: Map<string, Buffer[]>; purged: string[] } {
  const versions = new Map<string, Buffer[]>();
  const purged: string[] = [];
  const current = (key: string) => {
    const list = versions.get(key);
    if (!list?.length) throw new Error("NoSuchKey");
    return list.at(-1)!;
  };
  return {
    versions,
    purged,
    async put(key, bytes) {
      if (versions.has(key)) throw new Error("PreconditionFailed");
      versions.set(key, [Buffer.from(bytes)]);
    },
    async replace(key, bytes) {
      versions.set(key, [...(versions.get(key) ?? []), Buffer.from(bytes)]);
    },
    async get(key) {
      return current(key);
    },
    async remove(key, options) {
      versions.delete(key);
      if (options?.allVersions) purged.push(key);
    },
  };
}

/** How every record was sealed before feature 10: "v1", the server-wide key, the business id as AAD. */
function legacySeal(tenantId: string, plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", legacyRecordsKey(), iv);
  cipher.setAAD(Buffer.from(tenantId));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("v1"), iv, cipher.getAuthTag(), body]);
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describeLocal("protected storage jobs", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let runtime: postgres.Sql;
  const suffix = randomUUID().slice(0, 8);
  const store = memoryStore();
  let tenantA = "";
  let tenantB = "";
  let recordId = "";
  let fileId = "";
  let mediaId = "";
  let practitionerId = "";
  let patientA = "";

  /** Runs work inside one business's row-level scope on the worker's connection, as the jobs do. */
  function inTenant<T>(tenantId: string, work: (tenantDb: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return work(tenantDb);
    }) as Promise<T>;
  }

  async function makeTenant(label: string): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      insert into tenants (slug, name, legal_name, phone, email, timezone)
      values (${`storage-${label}-${suffix}`}, ${`Storage ${label}`}, ${`Storage ${label} LLP`}, '+919800000000',
        ${`storage-${label}-${suffix}@example.com`}, 'Asia/Kolkata')
      returning id`;
    return row!.id;
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    runtime = postgres(runtimeUrl!, { max: 1, prepare: false, onnotice: () => undefined });
    forgetDataKeys();
    tenantA = await makeTenant("a");
    tenantB = await makeTenant("b");
    const [patient] = await owner<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${tenantA}, 'Asha', 'Storage', '+919800000001', ${`asha-${suffix}@example.com`}, 'email') returning id`;
    patientA = patient!.id;

    // Data written before feature 10: version 0, the server-wide key.
    const [record] = await owner<{ id: string }[]>`
      insert into visit_records (tenant_id, patient_id, kind, title_ciphertext, body_ciphertext, key_version)
      values (${tenantA}, ${patientA}, 'report',
        ${legacySeal(tenantA, Buffer.from("Blood test")).toString("base64url")},
        ${legacySeal(tenantA, Buffer.from("Haemoglobin normal")).toString("base64url")}, 0)
      returning id`;
    recordId = record!.id;
    fileId = randomUUID();
    const oldKey = `${tenantA}/${fileId}`;
    await store.put(oldKey, legacySeal(tenantA, Buffer.from("%PDF-1.7 lab report")));
    await owner`
      insert into visit_record_files (id, tenant_id, record_id, storage_key, name_ciphertext, content_type, byte_size, sha256, key_version, scan_status)
      values (${fileId}, ${tenantA}, ${recordId}, ${oldKey}, ${legacySeal(tenantA, Buffer.from("report.pdf")).toString("base64url")},
        'application/pdf', 19, ${"0".repeat(64)}, 0, 'skipped')`;

    // Pictures still held in rows.
    const [media] = await owner<{ id: string }[]>`
      insert into media_assets (tenant_id, kind, owner_id, content_type, width, height, byte_size, data, scan_status)
      values (${tenantA}, 'business_logo', ${tenantA}, 'image/png', 1, 1, ${png.length}, ${png}, 'skipped')
      returning id`;
    mediaId = media!.id;
    const [practitioner] = await owner<{ id: string }[]>`
      insert into practitioners (tenant_id, name, title, initials, specialty, photo_data_url)
      values (${tenantA}, 'Dr Storage', 'Dentist', 'DS', 'General', ${`data:image/png;base64,${png.toString("base64")}`})
      returning id`;
    practitionerId = practitioner!.id;
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      for (const tenant of [tenantA, tenantB].filter(Boolean)) {
        await transaction`delete from outbox_events where tenant_id = ${tenant}`;
        await transaction`delete from audit_events where tenant_id = ${tenant}`;
        await transaction`delete from visit_record_files where tenant_id = ${tenant}`;
        await transaction`delete from visit_records where tenant_id = ${tenant}`;
        await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where tenant_id = ${tenant})`;
        await transaction`delete from patients where tenant_id = ${tenant}`;
        await transaction`delete from tenants where id = ${tenant}`;
      }
    }).catch((error: unknown) => console.error("storage test cleanup failed", error));
    forgetDataKeys();
    await Promise.all([owner.end(), worker.end(), runtime.end()]);
  });

  it("lists only businesses with work, by id, through the definer function", async () => {
    const tenants = (await worker<{ id: string }[]>`select kalendr_storage_tenants('re_encrypt') as id`).map((row) => row.id);
    expect(tenants).toContain(tenantA);
    expect(tenants).not.toContain(tenantB);
    const moving = (await worker<{ id: string }[]>`select kalendr_storage_tenants('media_backfill') as id`).map((row) => row.id);
    expect(moving).toContain(tenantA);
    await expect(runtime`select kalendr_storage_tenants('re_encrypt')`).rejects.toThrow(/permission denied/);
    const health = await storageHealth(worker);
    expect(health.recordsOnOldKeys).toBeGreaterThanOrEqual(2);
    expect(health.picturesToMove).toBeGreaterThanOrEqual(2);
  });

  it("moves pictures out of rows into the store, encrypted, and waits for a scan when scanning is on", async () => {
    const moved = await inTenant(tenantA, (tenantDb) => backfillTenantMedia(tenantDb, tenantA, { store, scanning: true }));
    expect(moved).toBe(2);
    const [logo] = await owner<{ data: Buffer | null; storage_key: string; key_version: number; scan_status: string }[]>`
      select data, storage_key, key_version, scan_status from media_assets where id = ${mediaId}`;
    expect(logo).toMatchObject({ data: null, storage_key: fileStoreKey(tenantA, "media", mediaId), key_version: 1, scan_status: "pending" });
    const stored = await store.get(logo!.storage_key);
    expect(stored.includes(png.subarray(1, 8))).toBe(false);
    forgetDataKeys();
    await inTenant(tenantA, (tenantDb) => loadDataKeys(postgresDataKeyStore(tenantDb), tenantA));
    expect(openBytes(tenantA, stored).equals(png)).toBe(true);

    const [photo] = await owner<{ photo_data_url: string | null }[]>`select photo_data_url from practitioners where id = ${practitionerId}`;
    expect(photo!.photo_data_url).toBeNull();
    const pictures = await owner<{ scan_status: string }[]>`
      select scan_status from media_assets where tenant_id = ${tenantA} and kind = 'practitioner' and owner_id = ${practitionerId}`;
    expect(pictures).toEqual([{ scan_status: "pending" }]);
    const scans = await owner`select 1 from outbox_events where tenant_id = ${tenantA} and event_type = 'file.scan'`;
    expect(scans).toHaveLength(2);
    expect(await inTenant(tenantA, (tenantDb) => backfillTenantMedia(tenantDb, tenantA, { store, scanning: true }))).toBe(0);
  });

  it("scans: a clean picture becomes usable; an infected record file is removed and recorded", async () => {
    const event = (payload: unknown): OutboxEvent => ({
      id: randomUUID(), tenantId: tenantA, aggregateType: "file", aggregateId: "x", eventType: "file.scan",
      payload, dedupeKey: randomUUID(), attemptCount: 0,
    });
    const clean: Scanner = { scan: async () => ({ status: "clean" }), ping: async () => true };
    const infected: Scanner = { scan: async () => ({ status: "infected", signature: "Eicar-Signature" }), ping: async () => true };
    const handler = scanFileHandler({ scanner: () => clean, store: () => store });
    expect(await inTenant(tenantA, (tenantDb) => handler(tenantDb, event({ table: "media_assets", id: mediaId })))).toBe("delivered");
    const [logo] = await owner<{ scan_status: string }[]>`select scan_status from media_assets where id = ${mediaId}`;
    expect(logo!.scan_status).toBe("clean");
    const [photo] = await owner<{ id: string }[]>`
      select id from media_assets where tenant_id = ${tenantA} and kind = 'practitioner' and owner_id = ${practitionerId}`;
    expect(await inTenant(tenantA, (tenantDb) => handler(tenantDb, event({ table: "media_assets", id: photo!.id })))).toBe("delivered");

    // No scanner yet: the event waits.
    const waiting = scanFileHandler({ scanner: () => null, store: () => store });
    const pendingId = randomUUID();
    const pendingKey = fileStoreKey(tenantA, "record", pendingId);
    await inTenant(tenantA, async (tenantDb) => {
      await loadDataKeys(postgresDataKeyStore(tenantDb), tenantA, { forWrite: true });
      await store.put(pendingKey, sealBytes(tenantA, Buffer.from("X5O!P%@AP test file")));
      await tenantDb`
        insert into visit_record_files (id, tenant_id, record_id, storage_key, name_ciphertext, content_type, byte_size, sha256, key_version, scan_status)
        values (${pendingId}, ${tenantA}, ${recordId}, ${pendingKey}, ${sealBytes(tenantA, Buffer.from("x.pdf")).toString("base64url")},
          'application/pdf', 19, ${"0".repeat(64)}, 1, 'pending')`;
    });
    expect(await inTenant(tenantA, (tenantDb) => waiting(tenantDb, event({ table: "visit_record_files", id: pendingId }))))
      .toEqual({ outcome: "retry", code: "scanner_unavailable" });

    const rejecting = scanFileHandler({ scanner: () => infected, store: () => store });
    expect(await inTenant(tenantA, (tenantDb) => rejecting(tenantDb, event({ table: "visit_record_files", id: pendingId })))).toBe("delivered");
    const [file] = await owner<{ scan_status: string }[]>`select scan_status from visit_record_files where id = ${pendingId}`;
    expect(file!.scan_status).toBe("infected");
    const [audit] = await owner<{ metadata: { signature: string; fileId: string } }[]>`
      select metadata from audit_events where tenant_id = ${tenantA} and action = 'record.file.infected'`;
    expect(audit!.metadata).toMatchObject({ signature: "Eicar-Signature", fileId: pendingId });
    const [removal] = await owner<{ payload: { key: string; purge?: boolean } }[]>`
      select payload from outbox_events where tenant_id = ${tenantA} and event_type = 'file.remove'`;
    // An infected file goes from the bucket's history too, not just its current version.
    expect(removal!.payload).toEqual({ key: pendingKey, purge: true });

    // The removal only touches this business's own objects.
    const remove = fileRemoveHandler({ store: () => store });
    expect(await inTenant(tenantA, (tenantDb) => remove(tenantDb, { ...event(removal!.payload), eventType: "file.remove" }))).toBe("delivered");
    expect(store.versions.has(pendingKey)).toBe(false);
    expect(store.purged).toEqual([pendingKey]);
    const elsewhere = fileStoreKey(tenantB, "record", "anything");
    expect(await inTenant(tenantA, (tenantDb) => remove(tenantDb, { ...event({ key: elsewhere }), eventType: "file.remove" })))
      .toEqual({ outcome: "dead", code: "invalid_payload" });
  });

  it("re-encrypts old records and files onto the business's key, then refuses the server-wide key", async () => {
    forgetDataKeys();
    const moved = await inTenant(tenantA, (tenantDb) => reEncryptTenant(tenantDb, tenantA, { store }));
    expect(moved).toBeGreaterThanOrEqual(2);
    const [record] = await owner<{ title_ciphertext: string; key_version: number }[]>`
      select title_ciphertext, key_version from visit_records where id = ${recordId}`;
    expect(record!.key_version).toBe(1);
    expect(keyVersionOfText(record!.title_ciphertext)).toBe(1);
    expect(openText(tenantA, record!.title_ciphertext)).toBe("Blood test");
    const [file] = await owner<{ storage_key: string; key_version: number }[]>`select storage_key, key_version from visit_record_files where id = ${fileId}`;
    expect(file!.key_version).toBe(1);
    const object = await store.get(file!.storage_key);
    expect(keyVersionOf(object)).toBe(1);
    expect(openBytes(tenantA, object).toString()).toBe("%PDF-1.7 lab report");

    const keys = await owner<{ version: number; provider: string; retired: boolean }[]>`
      select version, provider, retired_at is not null as retired from tenant_data_keys where tenant_id = ${tenantA} order by version`;
    expect(keys).toEqual([{ version: 0, provider: "legacy", retired: true }, { version: 1, provider: "local", retired: false }]);
    forgetDataKeys();
    await inTenant(tenantA, (tenantDb) => loadDataKeys(postgresDataKeyStore(tenantDb), tenantA));
    expect(() => openBytes(tenantA, legacySeal(tenantA, Buffer.from("planted")))).toThrow(/no longer accepts/);
  });

  it("after rotation, old and new data both open, then everything moves forward and the old key is retired", async () => {
    const earlier = await store.get(fileStoreKey(tenantA, "media", mediaId));
    const version = await inTenant(tenantA, (tenantDb) => rotateTenantKey(tenantDb, tenantA, "admin"));
    expect(version).toBe(2);
    await inTenant(tenantA, async (tenantDb) => {
      await loadDataKeys(postgresDataKeyStore(tenantDb), tenantA, { forWrite: true });
      expect(keyVersionOf(sealBytes(tenantA, Buffer.from("new")))).toBe(2);
    });
    expect(openBytes(tenantA, earlier).equals(png)).toBe(true);

    await inTenant(tenantA, (tenantDb) => reEncryptTenant(tenantDb, tenantA, { store }));
    const versions = await owner<{ key_version: number }[]>`
      select key_version from visit_records where tenant_id = ${tenantA}
      union all select key_version from visit_record_files where tenant_id = ${tenantA} and scan_status <> 'infected'
      union all select key_version from media_assets where tenant_id = ${tenantA}`;
    expect(new Set(versions.map((row) => row.key_version))).toEqual(new Set([2]));
    const [v1] = await owner<{ retired: boolean }[]>`
      select retired_at is not null as retired from tenant_data_keys where tenant_id = ${tenantA} and version = 1`;
    expect(v1!.retired).toBe(true);
    // A retired key still opens what it sealed (an old object version, a backup).
    forgetDataKeys();
    await inTenant(tenantA, (tenantDb) => loadDataKeys(postgresDataKeyStore(tenantDb), tenantA));
    expect(openBytes(tenantA, earlier).equals(png)).toBe(true);
    const [audit] = await owner<{ metadata: { version: number; reason: string } }[]>`
      select metadata from audit_events where tenant_id = ${tenantA} and action = 'security.keys.rotated'`;
    expect(audit!.metadata).toEqual({ version: 2, reason: "admin" });
  });

  it("rotates a key once it is a year old", async () => {
    await owner`update tenant_data_keys set created_at = now() - interval '400 days' where tenant_id = ${tenantA} and version = 2`;
    const summary = await rotateDueKeys(worker);
    expect(summary.tenants).toBeGreaterThanOrEqual(1);
    const [newest] = await owner<{ version: number }[]>`select max(version) as version from tenant_data_keys where tenant_id = ${tenantA}`;
    expect(newest!.version).toBe(3);
    const due = (await worker<{ id: string }[]>`select kalendr_storage_tenants('rotate_due') as id`).map((row) => row.id);
    expect(due).not.toContain(tenantA);
  });

  it("keeps businesses apart: keys are scoped by row-level security and ciphertext won't open elsewhere", async () => {
    const seenFromB = await inTenant(tenantB, (tenantDb) => tenantDb`select version from tenant_data_keys where tenant_id = ${tenantA}`);
    expect(seenFromB).toHaveLength(0);
    const unscoped = await worker`select 1 from tenant_data_keys`;
    expect(unscoped).toHaveLength(0);
    await expect(runtime.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${tenantB}, true)`;
      await transaction`insert into tenant_data_keys (tenant_id, version, provider, wrapped_key, master_key_id)
        values (${tenantA}, 99, 'local', ${randomBytes(60)}, 'local:0000000000000000')`;
    })).rejects.toThrow(/row-level security/);

    await inTenant(tenantB, (tenantDb) => loadDataKeys(postgresDataKeyStore(tenantDb), tenantB, { forWrite: true }));
    const [record] = await owner<{ title_ciphertext: string }[]>`select title_ciphertext from visit_records where id = ${recordId}`;
    expect(() => openText(tenantB, record!.title_ciphertext)).toThrow();
    // A's wrapped key copied into B's rows does not unwrap for B.
    await owner`
      insert into tenant_data_keys (tenant_id, version, provider, wrapped_key, master_key_id)
      select ${tenantB}, 50, provider, wrapped_key, master_key_id from tenant_data_keys where tenant_id = ${tenantA} and version = 3`;
    forgetDataKeys(tenantB);
    await expect(inTenant(tenantB, (tenantDb) => loadDataKeys(postgresDataKeyStore(tenantDb), tenantB))).rejects.toThrow();
  });
});
