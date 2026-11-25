/**
 * Where each business's data keys come from (feature 10, protected storage).
 *
 * Every business has its own 256-bit data key per version. The key is stored only in
 * wrapped form (tenant_data_keys.wrapped_key); a key provider wraps and unwraps it with a
 * master key the database never sees. Two providers exist:
 * - "local": the master key is KALENDR_LOCAL_MASTER_KEY on this server (development,
 *   single-server installs, tests).
 * - "kms": AWS KMS holds the master key; the server asks KMS to make and unwrap data keys.
 *
 * A row names the provider and master key that wrapped it, so a server can still unwrap
 * keys made before the provider setting changed, as long as it can reach that provider.
 *
 * No "server-only" import: the worker uses this module too.
 */
import { createHash } from "node:crypto";

import { ApiError } from "../api-error";
import { env } from "../env";
import { createKmsProvider } from "./kms";
import { createLocalProvider } from "./local";

export type KeyProviderName = "local" | "kms";

/** Bound into every wrap, so a wrapped key moved to another business or version won't unwrap. */
export interface DataKeyContext {
  tenantId: string;
  version: number;
}

export interface GeneratedDataKey {
  plaintext: Buffer;
  wrapped: Buffer;
  /** The master key that wrapped it, as the provider names it (a KMS key ARN, or local:<fingerprint>). */
  masterKeyId: string;
}

export interface KeyProvider {
  readonly name: KeyProviderName;
  generateDataKey(context: DataKeyContext): Promise<GeneratedDataKey>;
  unwrapDataKey(context: DataKeyContext, wrapped: Uint8Array, masterKeyId: string): Promise<Buffer>;
}

export function keysUnavailable(): ApiError {
  return new ApiError(503, "records_unavailable", "Records are not set up on this server.");
}

const providers = new Map<KeyProviderName, KeyProvider>();

function settings() {
  try {
    return env();
  } catch {
    throw keysUnavailable();
  }
}

/** The provider new data keys come from. Development defaults to the local provider. */
export function configuredKeyProvider(): KeyProvider {
  const { KALENDR_KEY_PROVIDER: name, NODE_ENV } = settings();
  if (!name && NODE_ENV === "production") throw keysUnavailable();
  return keyProviderNamed(name ?? "local");
}

/** The provider a stored row names. */
export function keyProviderNamed(name: KeyProviderName): KeyProvider {
  const cached = providers.get(name);
  if (cached) return cached;
  const values = settings();
  let provider: KeyProvider;
  if (name === "kms") {
    if (!values.KMS_KEY_ID || !values.KMS_REGION) throw keysUnavailable();
    provider = createKmsProvider({ keyId: values.KMS_KEY_ID, region: values.KMS_REGION });
  } else {
    provider = createLocalProvider(localMasterKey(values.KALENDR_LOCAL_MASTER_KEY, values.NODE_ENV));
  }
  providers.set(name, provider);
  return provider;
}

function localMasterKey(encoded: string | undefined, nodeEnv: string): Buffer {
  if (encoded) {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw keysUnavailable();
    return key;
  }
  // Production never falls back: without a real master key, records stay off.
  if (nodeEnv === "production") throw keysUnavailable();
  // A fixed, public development key for fake data only.
  return createHash("sha256").update("kalendr-development-only-master-key").digest();
}

/** Tests replace a provider (for example a stubbed KMS client). */
export function setKeyProviderForTests(name: KeyProviderName, provider: KeyProvider | undefined): void {
  if (provider) providers.set(name, provider);
  else providers.delete(name);
}
