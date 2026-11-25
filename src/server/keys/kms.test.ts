import { randomBytes } from "node:crypto";

import { DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { describe, expect, it } from "vitest";

import { createKmsProvider, type KmsSender } from "./kms";

/**
 * A stand-in for KMS: it wraps with a key of its own and, like KMS, refuses to unwrap under a
 * different encryption context. Not a test of AWS itself, which this project has not run against.
 */
function fakeKms() {
  const calls: (GenerateDataKeyCommand | DecryptCommand)[] = [];
  const issued = new Map<string, { plaintext: Buffer; context: string }>();
  const sender: KmsSender = {
    async send(command) {
      calls.push(command);
      if (command instanceof GenerateDataKeyCommand) {
        const plaintext = randomBytes(32);
        const blob = randomBytes(48);
        issued.set(blob.toString("hex"), { plaintext, context: JSON.stringify(command.input.EncryptionContext) });
        return { Plaintext: plaintext, CiphertextBlob: blob, KeyId: "arn:aws:kms:ap-south-1:000000000000:key/test" };
      }
      const found = issued.get(Buffer.from(command.input.CiphertextBlob!).toString("hex"));
      if (!found || found.context !== JSON.stringify(command.input.EncryptionContext)) {
        throw Object.assign(new Error("InvalidCiphertextException"), { name: "InvalidCiphertextException" });
      }
      return { Plaintext: found.plaintext };
    },
  };
  return { sender, calls };
}

describe("KMS key provider", () => {
  it("asks KMS for an AES-256 data key bound to the business and version", async () => {
    const kms = fakeKms();
    const provider = createKmsProvider({ keyId: "alias/kalendr", client: kms.sender });
    const generated = await provider.generateDataKey({ tenantId: "clinic_a", version: 3 });
    expect(generated.plaintext).toHaveLength(32);
    expect(generated.masterKeyId).toBe("arn:aws:kms:ap-south-1:000000000000:key/test");
    const request = kms.calls[0] as GenerateDataKeyCommand;
    expect(request.input).toEqual({
      KeyId: "alias/kalendr",
      KeySpec: "AES_256",
      EncryptionContext: { kalendr_tenant: "clinic_a", kalendr_key_version: "3" },
    });
  });

  it("unwraps with the same context, names the master key, and fails for another business", async () => {
    const kms = fakeKms();
    const provider = createKmsProvider({ keyId: "alias/kalendr", client: kms.sender });
    const generated = await provider.generateDataKey({ tenantId: "clinic_a", version: 1 });
    const unwrapped = await provider.unwrapDataKey({ tenantId: "clinic_a", version: 1 }, generated.wrapped, generated.masterKeyId);
    expect(unwrapped.equals(generated.plaintext)).toBe(true);
    expect((kms.calls[1] as DecryptCommand).input.KeyId).toBe(generated.masterKeyId);
    await expect(provider.unwrapDataKey({ tenantId: "clinic_b", version: 1 }, generated.wrapped, generated.masterKeyId)).rejects.toThrow();
    await expect(provider.unwrapDataKey({ tenantId: "clinic_a", version: 2 }, generated.wrapped, generated.masterKeyId)).rejects.toThrow();
  });

  it("refuses a reply without a 32-byte key", async () => {
    const provider = createKmsProvider({ keyId: "k", client: { send: async () => ({ Plaintext: randomBytes(16), CiphertextBlob: randomBytes(8) }) } });
    await expect(provider.generateDataKey({ tenantId: "t", version: 1 })).rejects.toThrow(/usable data key/);
    await expect(provider.unwrapDataKey({ tenantId: "t", version: 1 }, randomBytes(8), "k")).rejects.toThrow(/usable data key/);
  });
});
