/**
 * The AWS KMS key provider. KMS makes each data key (GenerateDataKey, AES_256) and returns
 * it twice: in plain form, used in memory only, and wrapped under the KMS key, which is what
 * the database stores. Opening a stored key is one Decrypt call; the result is cached per
 * process, so KMS is asked once per business key version, not once per record.
 *
 * The encryption context binds each wrapped key to its business and version. KMS refuses
 * to unwrap it under any other context, and CloudTrail logs the context with every use.
 *
 * Not verified against real AWS: tests stub the client (see kms.test.ts).
 */
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";

import type { DataKeyContext, GeneratedDataKey, KeyProvider } from "./provider";

/** The part of KMSClient this provider uses, so tests can pass a stub. */
export interface KmsSender {
  send(command: GenerateDataKeyCommand | DecryptCommand): Promise<unknown>;
}

export interface KmsProviderOptions {
  keyId: string;
  region?: string;
  client?: KmsSender;
}

function encryptionContext(context: DataKeyContext): Record<string, string> {
  return { kalendr_tenant: context.tenantId, kalendr_key_version: String(context.version) };
}

export function createKmsProvider({ keyId, region, client }: KmsProviderOptions): KeyProvider {
  const kms: KmsSender = client ?? new KMSClient({ region });
  return {
    name: "kms",
    async generateDataKey(context): Promise<GeneratedDataKey> {
      const result = (await kms.send(
        new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: "AES_256", EncryptionContext: encryptionContext(context) }),
      )) as { Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array; KeyId?: string };
      if (!result.Plaintext || result.Plaintext.length !== 32 || !result.CiphertextBlob) {
        throw new Error("KMS did not return a usable data key");
      }
      return {
        plaintext: Buffer.from(result.Plaintext),
        wrapped: Buffer.from(result.CiphertextBlob),
        masterKeyId: result.KeyId ?? keyId,
      };
    },
    async unwrapDataKey(context, wrapped, masterKeyId) {
      const result = (await kms.send(
        new DecryptCommand({
          CiphertextBlob: wrapped,
          KeyId: masterKeyId,
          EncryptionContext: encryptionContext(context),
        }),
      )) as { Plaintext?: Uint8Array };
      if (!result.Plaintext || result.Plaintext.length !== 32) throw new Error("KMS did not return a usable data key");
      return Buffer.from(result.Plaintext);
    },
  };
}
