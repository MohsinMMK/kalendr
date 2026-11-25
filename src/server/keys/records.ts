/**
 * Seal and open record data with the business's current data key. Synchronous: load the
 * business's keys first (loadDataKeys, or loadRecordKeys in the web app).
 *
 * The web app imports these through record-crypto.ts; the worker imports them from here.
 */
import { ciphertextKeyVersion, openWithKey, sealWithKey } from "./envelope";
import { currentKeyVersion, dataKeyFor } from "./ring";

/** The business id (and key version) are authenticated with the data, so a ciphertext copied to another clinic's row won't open. */
export function sealBytes(tenantId: string, plain: Uint8Array): Buffer {
  const version = currentKeyVersion(tenantId);
  return sealWithKey(dataKeyFor(tenantId, version), version, tenantId, plain);
}

export function openBytes(tenantId: string, sealed: Uint8Array): Buffer {
  return openWithKey(dataKeyFor(tenantId, ciphertextKeyVersion(sealed)), tenantId, sealed);
}

export function sealText(tenantId: string, plain: string): string {
  return sealBytes(tenantId, Buffer.from(plain, "utf8")).toString("base64url");
}

export function openText(tenantId: string, sealed: string): string {
  return openBytes(tenantId, Buffer.from(sealed, "base64url")).toString("utf8");
}

/** The key version a stored value was sealed with; it goes in the row's key_version column. */
export function keyVersionOf(sealed: Uint8Array): number {
  return ciphertextKeyVersion(sealed);
}

export function keyVersionOfText(sealed: string): number {
  return ciphertextKeyVersion(Buffer.from(sealed.slice(0, 12), "base64url"));
}

/** The version the next seal for this business will use. */
export function writeKeyVersion(tenantId: string): number {
  return currentKeyVersion(tenantId);
}
