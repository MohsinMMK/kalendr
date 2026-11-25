/**
 * Keeps an appointment's manage token readable by the worker, so emails can carry the
 * customer's private link. Only a hash of the token is used to look an appointment up; this
 * sealed copy is used for nothing but building the link in a message.
 *
 * AES-256-GCM with a key derived (HKDF, its own label) from KALENDR_RECORDS_KEY, so it never
 * shares a key with stored records. The business id and appointment id are authenticated
 * with the token, so a ciphertext copied onto another row won't open.
 *
 * This is separate from record-crypto.ts because that file is server-only and the worker
 * can't import it. When managed keys arrive (feature 10), fold this in there.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

import { env, type EnvironmentSource } from "../env";

const VERSION = "l1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function linkKey(source: EnvironmentSource): Buffer | null {
  const { KALENDR_RECORDS_KEY: encoded, NODE_ENV } = env(source);
  let base: Buffer;
  if (encoded) base = Buffer.from(encoded, "base64");
  else if (NODE_ENV === "production") return null;
  else base = createHash("sha256").update("kalendr-development-only-records-key").digest();
  return Buffer.from(hkdfSync("sha256", base, Buffer.alloc(0), "kalendr manage link v1", 32));
}

function aad(tenantId: string, appointmentId: string): Buffer {
  return Buffer.from(`${tenantId}\u0000${appointmentId}`);
}

/** The sealed token, or null when no key is set in production (the email then goes without a link). */
export function sealManageToken(tenantId: string, appointmentId: string, token: string, source: EnvironmentSource = process.env): string | null {
  const key = linkKey(source);
  if (!key) return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(tenantId, appointmentId));
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

/** The token, or null when it can't be opened (no key, wrong row, tampered or unknown format). */
export function openManageToken(tenantId: string, appointmentId: string, sealed: string | null, source: EnvironmentSource = process.env): string | null {
  if (!sealed?.startsWith(`${VERSION}.`)) return null;
  try {
    const key = linkKey(source);
    if (!key) return null;
    const data = Buffer.from(sealed.slice(VERSION.length + 1), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, IV_BYTES));
    decipher.setAAD(aad(tenantId, appointmentId));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The same sealing for other small private things the worker must read later: a guest list on a booking, or the
 * address and code of an email check. `purpose` is part of what is authenticated, so a sealed guest list can never be
 * opened as a manage token or as an email check, and the business and row ids tie it to one place.
 */
export function sealPrivate(purpose: string, tenantId: string, rowId: string, text: string, source: EnvironmentSource = process.env): string | null {
  return sealManageToken(tenantId, `${purpose}\u0000${rowId}`, text, source);
}

export function openPrivate(purpose: string, tenantId: string, rowId: string, sealed: string | null, source: EnvironmentSource = process.env): string | null {
  return openManageToken(tenantId, `${purpose}\u0000${rowId}`, sealed, source);
}
