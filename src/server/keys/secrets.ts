/**
 * Secrets that other features store for a business — OAuth tokens (calendar sync), payment
 * gateway keys, webhook secrets — sealed with the same per-business data key as records.
 *
 * Each secret is bound to its purpose as well as its business, so a token copied from one
 * column or business to another will not open. Store the result in a text column and keep
 * its version (secretKeyVersion) in a key_version column beside it, and add the table to the
 * re-encryption job (src/worker/storage-jobs.ts) so rotation moves it forward.
 *
 * Load the business's keys first, as for records: loadRecordKeys(transaction, tenantId,
 * { forWrite: true }) in the web app, loadDataKeys(...) in the worker.
 */
import { ciphertextKeyVersion, openWithKey, sealWithKey } from "./envelope";
import { currentKeyVersion, dataKeyFor } from "./ring";

const prefix = "s1.";

/** Lowercase words joined by dots or dashes, e.g. "calendar.google.refresh-token". */
const purposePattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

function secretAad(tenantId: string, purpose: string): string {
  if (!purposePattern.test(purpose)) throw new Error("Invalid secret purpose");
  return `${tenantId}\0secret\0${purpose}`;
}

export function sealSecret(tenantId: string, purpose: string, value: string): string {
  const version = currentKeyVersion(tenantId);
  // Version 0 is the old server-wide records key. Secrets always use the business's own key.
  if (version < 1) throw new Error("Load the business's keys with forWrite before sealing a secret");
  const sealed = sealWithKey(dataKeyFor(tenantId, version), version, secretAad(tenantId, purpose), Buffer.from(value, "utf8"));
  return prefix + sealed.toString("base64url");
}

export function openSecret(tenantId: string, purpose: string, sealed: string): string {
  const data = secretBytes(sealed);
  if (ciphertextKeyVersion(data) < 1) throw new Error("Unknown secret format");
  return openWithKey(dataKeyFor(tenantId, ciphertextKeyVersion(data)), secretAad(tenantId, purpose), data).toString("utf8");
}

/** The key version a stored secret was sealed with, for its key_version column. */
export function secretKeyVersion(sealed: string): number {
  return ciphertextKeyVersion(secretBytes(sealed));
}

function secretBytes(sealed: string): Buffer {
  if (!sealed.startsWith(prefix)) throw new Error("Unknown secret format");
  return Buffer.from(sealed.slice(prefix.length), "base64url");
}
