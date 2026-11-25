/**
 * The local key provider: data keys are wrapped with AES-256-GCM under a master key held in
 * KALENDR_LOCAL_MASTER_KEY. The wrap is bound to the business and key version, so a wrapped
 * key copied to another business's row will not unwrap. masterKeyId is a short fingerprint
 * of the master key, never the key itself, so a server with the wrong master key says so
 * instead of returning garbage.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { DataKeyContext, GeneratedDataKey, KeyProvider } from "./provider";

const header = Buffer.from("L1");
const ivBytes = 12;
const tagBytes = 16;

function bound(context: DataKeyContext): Buffer {
  return Buffer.from(`kalendr-data-key\0${context.tenantId}\0${context.version}`);
}

export function localMasterKeyId(masterKey: Uint8Array): string {
  return `local:${createHash("sha256").update(masterKey).digest("hex").slice(0, 16)}`;
}

export function createLocalProvider(masterKey: Buffer): KeyProvider {
  if (masterKey.length !== 32) throw new Error("The local master key must be 32 bytes");
  const masterKeyId = localMasterKeyId(masterKey);

  function wrap(context: DataKeyContext, plaintext: Buffer): Buffer {
    const iv = randomBytes(ivBytes);
    const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
    cipher.setAAD(bound(context));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
  }

  return {
    name: "local",
    async generateDataKey(context): Promise<GeneratedDataKey> {
      const plaintext = randomBytes(32);
      return { plaintext, wrapped: wrap(context, plaintext), masterKeyId };
    },
    async unwrapDataKey(context, wrapped, wrappedWith) {
      if (wrappedWith !== masterKeyId) {
        throw new Error("This data key was wrapped by a different local master key");
      }
      const data = Buffer.from(wrapped);
      if (!data.subarray(0, header.length).equals(header)) throw new Error("Unknown wrapped key format");
      const tagStart = header.length + ivBytes;
      const bodyStart = tagStart + tagBytes;
      const decipher = createDecipheriv("aes-256-gcm", masterKey, data.subarray(header.length, tagStart));
      decipher.setAAD(bound(context));
      decipher.setAuthTag(data.subarray(tagStart, bodyStart));
      const key = Buffer.concat([decipher.update(data.subarray(bodyStart)), decipher.final()]);
      if (key.length !== 32) throw new Error("Unwrapped data key has the wrong length");
      return key;
    },
  };
}
