import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import { CALENDAR_CREDENTIALS_PURPOSE } from "../lib/calendar-sync";
import { PUSH_SECRET_PURPOSE } from "../lib/staff-alerts";
import { PAYMENT_SECRET_PURPOSE, PAYMENT_WEBHOOK_PURPOSE } from "../server/payments/credentials";
import { fileStoreKey, getFileStore, type FileStore } from "../server/file-store";
import { readMediaDimensions, sniffMediaType } from "../server/media-bytes";
import { postgresDataKeyStore } from "../server/keys/postgres-store";
import { openBytes, openText, sealBytes, sealText } from "../server/keys/records";
import { loadDataKeys, rotateDataKey } from "../server/keys/ring";
import { openSecret, sealSecret, secretKeyVersion } from "../server/keys/secrets";
import { configuredScanner } from "../server/scan/clamav";

/**
 * The protected-storage jobs: moving data onto each business's newest key, rotating keys once
 * a year, and moving pictures out of database rows into the encrypted file store.
 *
 * Like the other timed jobs, the worker finds which businesses have work through a definer
 * function that returns ids only (kalendr_storage_tenants), then works inside each business's
 * own row-level scope. Every step is batched and safe to repeat or run beside the web app.
 */

type StorageJob = "re_encrypt" | "rotate_due" | "media_backfill";

/** Rows per table per business per run. Small, so one run never holds locks for long. */
const RE_ENCRYPT_BATCH = 200;
const FILE_BATCH = 25;
const BACKFILL_BATCH = 25;

export interface StorageJobOptions {
  store?: FileStore;
  /** Whether new pictures wait for a virus scan. Defaults to whether ClamAV is configured. */
  scanning?: boolean;
}

export interface StorageJobSummary {
  tenants: number;
  rows: number;
}

async function forEachStorageTenant(
  database: postgres.Sql,
  job: StorageJob,
  work: (tenantDb: postgres.TransactionSql, tenantId: string) => Promise<number>,
): Promise<StorageJobSummary> {
  const tenants = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_storage_tenants(${job}) as tenant_id`;
  let rows = 0;
  for (const { tenant_id: tenantId } of tenants) {
    rows += await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return work(tenantDb, tenantId);
    }) as number;
  }
  return { tenants: tenants.length, rows };
}

function reseal(tenantId: string, sealed: string): string {
  return sealText(tenantId, openText(tenantId, sealed));
}

function resealSecret(tenantId: string, purpose: string, sealed: string): string {
  return sealSecret(tenantId, purpose, openSecret(tenantId, purpose, sealed));
}

/**
 * Re-encrypts one batch of a business's data under its newest key: record text, form
 * answers, record files and pictures. Each row is locked and skipped if someone else holds
 * it; each update checks the version it read, so a change made meanwhile is never overwritten
 * with stale text. Stored files are replaced in place: the old and new ciphertext both open.
 *
 * When nothing is left on a version, that version is retired (marked, never deleted: retired
 * keys still open). Once nothing is left on version 0, the old server-wide key is refused for
 * this business from then on.
 */
export async function reEncryptTenant(
  tenantDb: postgres.TransactionSql,
  tenantId: string,
  options: StorageJobOptions = {},
): Promise<number> {
  const keyStore = postgresDataKeyStore(tenantDb);
  const target = await loadDataKeys(keyStore, tenantId, { forWrite: true });
  let moved = 0;

  const records = await tenantDb<{ id: string; title_ciphertext: string; body_ciphertext: string; key_version: number }[]>`
    select id, title_ciphertext, body_ciphertext, key_version from visit_records
    where tenant_id = ${tenantId} and key_version < ${target}
    order by id limit ${RE_ENCRYPT_BATCH} for update skip locked`;
  for (const record of records) {
    const updated = await tenantDb`
      update visit_records
      set title_ciphertext = ${reseal(tenantId, record.title_ciphertext)},
        body_ciphertext = ${reseal(tenantId, record.body_ciphertext)}, key_version = ${target}
      where tenant_id = ${tenantId} and id = ${record.id} and key_version = ${record.key_version}
      returning id`;
    moved += updated.length;
  }

  const forms = await tenantDb<{ id: string; response_ciphertext: string; key_version: number }[]>`
    select id, response_ciphertext, key_version from forms
    where tenant_id = ${tenantId} and response_ciphertext is not null and key_version < ${target}
    order by id limit ${RE_ENCRYPT_BATCH} for update skip locked`;
  for (const form of forms) {
    const updated = await tenantDb`
      update forms set response_ciphertext = ${reseal(tenantId, form.response_ciphertext)}, key_version = ${target}
      where tenant_id = ${tenantId} and id = ${form.id} and key_version = ${form.key_version}
      returning id`;
    moved += updated.length;
  }

  // Inbox messages are sealed with the business's key too; they move with everything else.
  const inbox = await tenantDb<{ id: string; body_ciphertext: string; key_version: number }[]>`
    select id, body_ciphertext, key_version from messages
    where tenant_id = ${tenantId} and body_ciphertext is not null and key_version < ${target}
    order by id limit ${RE_ENCRYPT_BATCH} for update skip locked`;
  for (const message of inbox) {
    const updated = await tenantDb`
      update messages set body_ciphertext = ${reseal(tenantId, message.body_ciphertext)}, key_version = ${target}
      where tenant_id = ${tenantId} and id = ${message.id} and key_version = ${message.key_version}
      returning id`;
    moved += updated.length;
  }

  const store = options.store ?? getFileStore();
  const files = await tenantDb<{ id: string; storage_key: string; name_ciphertext: string; key_version: number }[]>`
    select id, storage_key, name_ciphertext, key_version from visit_record_files
    where tenant_id = ${tenantId} and key_version < ${target} and scan_status in ('clean', 'skipped')
    order by id limit ${FILE_BATCH} for update skip locked`;
  for (const file of files) {
    const plain = openBytes(tenantId, await store.get(file.storage_key));
    await store.replace(file.storage_key, sealBytes(tenantId, plain));
    const updated = await tenantDb`
      update visit_record_files set name_ciphertext = ${reseal(tenantId, file.name_ciphertext)}, key_version = ${target}
      where tenant_id = ${tenantId} and id = ${file.id} and key_version = ${file.key_version}
      returning id`;
    moved += updated.length;
  }

  const pictures = await tenantDb<{ id: string; storage_key: string; key_version: number }[]>`
    select id, storage_key, key_version from media_assets
    where tenant_id = ${tenantId} and storage_key is not null and key_version < ${target}
      and scan_status in ('clean', 'skipped')
    order by id limit ${FILE_BATCH} for update skip locked`;
  for (const picture of pictures) {
    const plain = openBytes(tenantId, await store.get(picture.storage_key));
    await store.replace(picture.storage_key, sealBytes(tenantId, plain));
    const updated = await tenantDb`
      update media_assets set key_version = ${target}
      where tenant_id = ${tenantId} and id = ${picture.id} and key_version = ${picture.key_version}
      returning id`;
    moved += updated.length;
  }

  const subscriptions = await tenantDb<{ id: string; subscription_ciphertext: string; key_version: number }[]>`
    select id, subscription_ciphertext, key_version from push_subscriptions
    where tenant_id = ${tenantId} and key_version < ${target}
    order by id limit ${RE_ENCRYPT_BATCH} for update skip locked`;
  for (const subscription of subscriptions) {
    const sealed = sealSecret(tenantId, PUSH_SECRET_PURPOSE, openSecret(tenantId, PUSH_SECRET_PURPOSE, subscription.subscription_ciphertext));
    const updated = await tenantDb`
      update push_subscriptions set subscription_ciphertext = ${sealed}, key_version = ${secretKeyVersion(sealed)}
      where tenant_id = ${tenantId} and id = ${subscription.id} and key_version = ${subscription.key_version}
      returning id`;
    moved += updated.length;
  }

  const calendarLogins = await tenantDb<{ id: string; credentials_ciphertext: string; key_version: number }[]>`
    select id, credentials_ciphertext, key_version from calendar_connections
    where tenant_id = ${tenantId} and key_version < ${target}
    order by id limit ${RE_ENCRYPT_BATCH} for update skip locked`;
  for (const login of calendarLogins) {
    const sealed = sealSecret(tenantId, CALENDAR_CREDENTIALS_PURPOSE, openSecret(tenantId, CALENDAR_CREDENTIALS_PURPOSE, login.credentials_ciphertext));
    const updated = await tenantDb`
      update calendar_connections set credentials_ciphertext = ${sealed}, key_version = ${secretKeyVersion(sealed)}
      where tenant_id = ${tenantId} and id = ${login.id} and key_version = ${login.key_version}
      returning id`;
    moved += updated.length;
  }

  // Each business's payment gateway keys (feature 23).
  const paymentAccounts = await tenantDb<{ id: string; secret_ciphertext: string | null; webhook_secret_ciphertext: string | null; key_version: number }[]>`
    select id, secret_ciphertext, webhook_secret_ciphertext, key_version from tenant_payment_accounts
    where tenant_id = ${tenantId} and key_version < ${target} and (secret_ciphertext is not null or webhook_secret_ciphertext is not null)
    order by id limit ${RE_ENCRYPT_BATCH} for update skip locked`;
  for (const account of paymentAccounts) {
    const secret = account.secret_ciphertext ? sealSecret(tenantId, PAYMENT_SECRET_PURPOSE, openSecret(tenantId, PAYMENT_SECRET_PURPOSE, account.secret_ciphertext)) : null;
    const webhook = account.webhook_secret_ciphertext ? sealSecret(tenantId, PAYMENT_WEBHOOK_PURPOSE, openSecret(tenantId, PAYMENT_WEBHOOK_PURPOSE, account.webhook_secret_ciphertext)) : null;
    const updated = await tenantDb`
      update tenant_payment_accounts set secret_ciphertext = ${secret}, webhook_secret_ciphertext = ${webhook}, key_version = ${secretKeyVersion(secret ?? webhook ?? "")}
      where tenant_id = ${tenantId} and id = ${account.id} and key_version = ${account.key_version}
      returning id`;
    moved += updated.length;
  }

  // Credentials of installed apps (feature 55). The purpose names the app, so one app's token cannot open as another's.
  const appCredentials = await tenantDb<{ id: string; app_key: string; credentials_ciphertext: string; key_version: number }[]>`
    select id, app_key, credentials_ciphertext, key_version from app_installs
    where tenant_id = ${tenantId} and credentials_ciphertext is not null and key_version < ${target}
    order by id limit ${RE_ENCRYPT_BATCH} for update skip locked`;
  for (const install of appCredentials) {
    const purpose = `app.${install.app_key}`;
    const sealed = sealSecret(tenantId, purpose, openSecret(tenantId, purpose, install.credentials_ciphertext));
    const updated = await tenantDb`
      update app_installs set credentials_ciphertext = ${sealed}, key_version = ${secretKeyVersion(sealed)}
      where tenant_id = ${tenantId} and id = ${install.id} and key_version = ${install.key_version}
      returning id`;
    moved += updated.length;
  }

  // A guardian's sealed contact (feature 7): small, so every one on an older key moves in this run.
  const guardians = await tenantDb<{ id: string; guardian_contact_ciphertext: string; guardian_key_version: number }[]>`
    select id, guardian_contact_ciphertext, guardian_key_version from patients
    where tenant_id = ${tenantId} and guardian_contact_ciphertext is not null and guardian_key_version < ${target}
    order by id limit ${RE_ENCRYPT_BATCH} for update skip locked`;
  for (const guardian of guardians) {
    const resealed = resealSecret(tenantId, "patient.guardian-contact", guardian.guardian_contact_ciphertext);
    const updated = await tenantDb`
      update patients set guardian_contact_ciphertext = ${resealed}, guardian_key_version = ${target}
      where tenant_id = ${tenantId} and id = ${guardian.id} and guardian_key_version = ${guardian.guardian_key_version}
      returning id`;
    moved += updated.length;
  }

  // A merge's saved details (feature 27) live for 30 days at most; they move forward with everything else so an undo still opens.
  const merges = await tenantDb<{ id: string; snapshot_ciphertext: string; snapshot_key_version: number }[]>`
    select id, snapshot_ciphertext, snapshot_key_version from customer_merges
    where tenant_id = ${tenantId} and snapshot_ciphertext is not null and snapshot_key_version < ${target}
    order by id limit ${RE_ENCRYPT_BATCH} for update skip locked`;
  for (const merge of merges) {
    const resealed = resealSecret(tenantId, "customer.merge-snapshot", merge.snapshot_ciphertext);
    const updated = await tenantDb`
      update customer_merges set snapshot_ciphertext = ${resealed}, snapshot_key_version = ${target}
      where tenant_id = ${tenantId} and id = ${merge.id} and snapshot_key_version = ${merge.snapshot_key_version}
      returning id`;
    moved += updated.length;
  }

  await retireUnusedVersions(tenantDb, tenantId, target);
  return moved;
}

/** The key versions any stored data still uses. Infected files are never opened, so they don't count. */
async function versionsInUse(tenantDb: postgres.TransactionSql, tenantId: string): Promise<Set<number>> {
  const rows = await tenantDb<{ key_version: number }[]>`
    select distinct key_version from visit_records where tenant_id = ${tenantId}
    union select distinct key_version from forms where tenant_id = ${tenantId} and response_ciphertext is not null
    union select distinct key_version from messages where tenant_id = ${tenantId} and body_ciphertext is not null
    union select distinct key_version from visit_record_files where tenant_id = ${tenantId} and scan_status <> 'infected'
    union select distinct key_version from media_assets where tenant_id = ${tenantId} and storage_key is not null
    union select distinct key_version from push_subscriptions where tenant_id = ${tenantId}
    union select distinct key_version from calendar_connections where tenant_id = ${tenantId}
    union select distinct key_version from app_installs where tenant_id = ${tenantId} and credentials_ciphertext is not null

    union select distinct guardian_key_version from patients where tenant_id = ${tenantId} and guardian_contact_ciphertext is not null
    union select distinct snapshot_key_version from customer_merges where tenant_id = ${tenantId} and snapshot_ciphertext is not null
    union select distinct key_version from data_exports where tenant_id = ${tenantId} and expires_at > now() and used_at is null`;
  return new Set(rows.map((row) => row.key_version));
}

async function retireUnusedVersions(tenantDb: postgres.TransactionSql, tenantId: string, target: number): Promise<void> {
  const inUse = await versionsInUse(tenantDb, tenantId);
  for (let version = 1; version < target; version += 1) {
    if (inUse.has(version)) continue;
    await tenantDb`
      update tenant_data_keys set retired_at = now()
      where tenant_id = ${tenantId} and version = ${version} and retired_at is null`;
  }
  if (!inUse.has(0)) {
    await postgresDataKeyStore(tenantDb).insert(tenantId, {
      version: 0,
      provider: "legacy",
      wrappedKey: null,
      masterKeyId: null,
      retired: true,
    });
  }
}

export function reEncryptStorage(database: postgres.Sql, options: StorageJobOptions = {}): Promise<StorageJobSummary> {
  return forEachStorageTenant(database, "re_encrypt", (tenantDb, tenantId) => reEncryptTenant(tenantDb, tenantId, options));
}

/** Rotates a business's key, records it, and leaves re-encryption to the next re-encrypt run. */
export async function rotateTenantKey(
  tenantDb: postgres.TransactionSql,
  tenantId: string,
  reason: "yearly" | "admin",
  actorUserId: string | null = null,
): Promise<number> {
  const version = await rotateDataKey(postgresDataKeyStore(tenantDb), tenantId);
  await tenantDb`
    insert into audit_events (tenant_id, actor_type, actor_user_id, action, outcome, metadata)
    values (${tenantId}, ${actorUserId ? "staff" : "system"}, ${actorUserId}, 'security.keys.rotated', 'success',
      ${tenantDb.json({ version, reason })})`;
  return version;
}

/** Each business's newest key is replaced once it is a year old. */
export function rotateDueKeys(database: postgres.Sql): Promise<StorageJobSummary> {
  return forEachStorageTenant(database, "rotate_due", async (tenantDb, tenantId) => {
    await rotateTenantKey(tenantDb, tenantId, "yearly");
    return 1;
  });
}

const dataUrlPattern = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/;

async function queueScan(tenantDb: postgres.TransactionSql, tenantId: string, mediaId: string): Promise<void> {
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'media_asset', ${mediaId}, 'file.scan', ${tenantDb.json({ table: "media_assets", id: mediaId })},
      ${`file.scan:media_assets:${mediaId}`})
    on conflict (tenant_id, dedupe_key) do nothing`;
}

/**
 * Moves pictures still held in database rows into the encrypted file store: business
 * pictures (media_assets.data) and staff photos (practitioners.photo_data_url). Each keeps
 * its address. With scanning on, a moved picture waits for its scan like a new upload.
 * Safe to repeat: the object is written with replace, and the row update is what commits.
 */
export async function backfillTenantMedia(
  tenantDb: postgres.TransactionSql,
  tenantId: string,
  options: StorageJobOptions = {},
): Promise<number> {
  const store = options.store ?? getFileStore();
  const scanning = options.scanning ?? configuredScanner() !== null;
  const status = scanning ? "pending" : "skipped";
  const version = await loadDataKeys(postgresDataKeyStore(tenantDb), tenantId, { forWrite: true });
  let moved = 0;

  const pictures = await tenantDb<{ id: string; data: Buffer }[]>`
    select id, data from media_assets
    where tenant_id = ${tenantId} and storage_key is null and data is not null
    order by id limit ${BACKFILL_BATCH} for update skip locked`;
  for (const picture of pictures) {
    const storageKey = fileStoreKey(tenantId, "media", picture.id);
    await store.replace(storageKey, sealBytes(tenantId, picture.data));
    await tenantDb`
      update media_assets set data = null, storage_key = ${storageKey}, key_version = ${version}, scan_status = ${status}
      where tenant_id = ${tenantId} and id = ${picture.id}`;
    if (scanning) await queueScan(tenantDb, tenantId, picture.id);
    moved += 1;
  }

  const photos = await tenantDb<{ id: string; photo_data_url: string; has_picture: boolean }[]>`
    select practitioner.id, practitioner.photo_data_url,
      exists (select 1 from media_assets as media where media.tenant_id = practitioner.tenant_id
        and media.kind = 'practitioner' and media.owner_id = practitioner.id) as has_picture
    from practitioners as practitioner
    where practitioner.tenant_id = ${tenantId} and practitioner.photo_data_url is not null
    order by practitioner.id limit ${BACKFILL_BATCH} for update of practitioner skip locked`;
  for (const photo of photos) {
    if (!photo.has_picture) {
      const match = dataUrlPattern.exec(photo.photo_data_url);
      const bytes = match ? Buffer.from(match[2]!.replace(/\s/g, ""), "base64") : Buffer.alloc(0);
      const contentType = sniffMediaType(bytes, { allowPng: true });
      const size = contentType ? readMediaDimensions(bytes, contentType) : null;
      if (contentType && size) {
        const id = randomUUID();
        const storageKey = fileStoreKey(tenantId, "media", id);
        await store.replace(storageKey, sealBytes(tenantId, bytes));
        await tenantDb`
          insert into media_assets (id, tenant_id, kind, owner_id, content_type, width, height, byte_size, data, storage_key, key_version, scan_status)
          values (${id}, ${tenantId}, 'practitioner', ${photo.id}, ${contentType}, ${size.width}, ${size.height}, ${bytes.length},
            null, ${storageKey}, ${version}, ${status})`;
        if (scanning) await queueScan(tenantDb, tenantId, id);
      } else {
        // Not a picture this app can show. It is dropped rather than kept in the database.
        await tenantDb`
          insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
          values (${tenantId}, 'system', 'staff.photo.unreadable', 'failed', ${tenantDb.json({ practitionerId: photo.id })})`;
      }
    }
    await tenantDb`update practitioners set photo_data_url = null where tenant_id = ${tenantId} and id = ${photo.id}`;
    moved += 1;
  }
  return moved;
}

export function backfillMedia(database: postgres.Sql, options: StorageJobOptions = {}): Promise<StorageJobSummary> {
  return forEachStorageTenant(database, "media_backfill", (tenantDb, tenantId) => backfillTenantMedia(tenantDb, tenantId, options));
}

export interface StorageHealth {
  recordsOnOldKeys: number;
  filesWaitingForScan: number;
  picturesToMove: number;
}

/** Counts only, across every business, for the worker's log and alerts. */
export async function storageHealth(database: postgres.Sql): Promise<StorageHealth> {
  const [row] = await database<{ records_on_old_keys: string; files_waiting_for_scan: string; pictures_to_move: string }[]>`
    select records_on_old_keys, files_waiting_for_scan, pictures_to_move from kalendr_storage_health()`;
  return {
    recordsOnOldKeys: Number(row?.records_on_old_keys ?? 0),
    filesWaitingForScan: Number(row?.files_waiting_for_scan ?? 0),
    picturesToMove: Number(row?.pictures_to_move ?? 0),
  };
}
