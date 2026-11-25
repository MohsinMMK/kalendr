/**
 * The record ciphertext format, and the version-0 key.
 *
 * Two formats exist:
 * - "v1" | iv(12) | tag(16) | body   — written before feature 10. Sealed with the server-wide
 *   KALENDR_RECORDS_KEY, authenticated with the business id. This is key version 0.
 * - "k2" | version(uint32 BE) | iv(12) | tag(16) | body   — sealed with the business's own data
 *   key of that version, authenticated with the business id and the version.
 *
 * AES-256-GCM in both. A ciphertext always says which key opens it, so old and new records
 * stay readable side by side while the re-encryption job moves old ones forward.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { env } from "../env";
import { keysUnavailable } from "./provider";

const legacyHeader = Buffer.from("v1");
const versionedHeader = Buffer.from("k2");
const ivBytes = 12;
const tagBytes = 16;

/** KALENDR_RECORDS_KEY, the key every record written before feature 10 was sealed with. */
export function legacyRecordsKey(): Buffer {
  let settings;
  try {
    settings = env();
  } catch {
    // A malformed key (wrong length, not base64) keeps records off rather than failing open.
    throw keysUnavailable();
  }
  const { KALENDR_RECORDS_KEY: encoded, NODE_ENV } = settings;
  if (encoded) {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw keysUnavailable();
    return key;
  }
  // Records stay off in production until a real key is configured. Development gets a fixed key for fake data.
  if (NODE_ENV === "production") throw keysUnavailable();
  return createHash("sha256").update("kalendr-development-only-records-key").digest();
}

/** Which key version sealed this ciphertext. Throws on anything that is not a record ciphertext. */
export function ciphertextKeyVersion(sealed: Uint8Array): number {
  const data = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const header = data.subarray(0, 2);
  if (header.equals(legacyHeader)) return 0;
  if (header.equals(versionedHeader) && data.length >= 6) return data.readUInt32BE(2);
  throw new Error("Unknown record ciphertext version");
}

function versionedAad(tenantId: string, version: number): Buffer {
  return Buffer.from(`${tenantId}\0${version}`);
}

export function sealWithKey(key: Buffer, version: number, tenantId: string, plain: Uint8Array): Buffer {
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (version === 0) {
    cipher.setAAD(Buffer.from(tenantId));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([legacyHeader, iv, cipher.getAuthTag(), body]);
  }
  cipher.setAAD(versionedAad(tenantId, version));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const versionBytes = Buffer.alloc(4);
  versionBytes.writeUInt32BE(version);
  return Buffer.concat([versionedHeader, versionBytes, iv, cipher.getAuthTag(), body]);
}

export function openWithKey(key: Buffer, tenantId: string, sealed: Uint8Array): Buffer {
  const data = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const version = ciphertextKeyVersion(data);
  const ivStart = version === 0 ? legacyHeader.length : versionedHeader.length + 4;
  const tagStart = ivStart + ivBytes;
  const bodyStart = tagStart + tagBytes;
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(ivStart, tagStart));
  decipher.setAAD(version === 0 ? Buffer.from(tenantId) : versionedAad(tenantId, version));
  decipher.setAuthTag(data.subarray(tagStart, bodyStart));
  return Buffer.concat([decipher.update(data.subarray(bodyStart)), decipher.final()]);
}
