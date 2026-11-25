import { DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { fileStoreKey } from "./file-store-keys";
import { createS3FileStore, type S3Sender } from "./file-store-s3";

/** A bucket in memory that behaves like S3 for the calls the store makes. Not a test of AWS itself. */
function fakeBucket() {
  const objects = new Map<string, Buffer>();
  const calls: (PutObjectCommand | GetObjectCommand | DeleteObjectCommand | ListObjectVersionsCommand)[] = [];
  const sender: S3Sender = {
    async send(command) {
      calls.push(command);
      if (command instanceof ListObjectVersionsCommand) return {};
      const key = command.input.Key!;
      if (command instanceof PutObjectCommand) {
        if (command.input.IfNoneMatch === "*" && objects.has(key)) {
          throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed" });
        }
        objects.set(key, Buffer.from(command.input.Body as Uint8Array));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const body = objects.get(key);
        if (!body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      objects.delete(key);
      return {};
    },
  };
  return { sender, objects, calls };
}

describe("S3 file store", () => {
  const key = fileStoreKey("clinic_a", "record", "file_1");

  it("writes opaque bytes under the business's prefix, once, and reads them back", async () => {
    const bucket = fakeBucket();
    const store = createS3FileStore({ bucket: "kalendr-files", client: bucket.sender });
    const bytes = Buffer.from("k2-ciphertext");
    await store.put(key, bytes);
    expect(key).toBe("tenant/clinic_a/record/file_1");
    const put = bucket.calls[0] as PutObjectCommand;
    expect(put.input).toMatchObject({
      Bucket: "kalendr-files",
      Key: key,
      ContentType: "application/octet-stream",
      ContentLength: bytes.byteLength,
      IfNoneMatch: "*",
    });
    expect(put.input).not.toHaveProperty("ACL");
    expect((await store.get(key)).equals(bytes)).toBe(true);
    await expect(store.put(key, Buffer.from("again"))).rejects.toThrow(/PreconditionFailed/);
  });

  it("replaces in place for re-encryption, and removes", async () => {
    const bucket = fakeBucket();
    const store = createS3FileStore({ bucket: "kalendr-files", client: bucket.sender });
    await store.put(key, Buffer.from("old"));
    await store.replace(key, Buffer.from("new"));
    expect((bucket.calls[1] as PutObjectCommand).input.IfNoneMatch).toBeUndefined();
    expect((await store.get(key)).toString()).toBe("new");
    await store.remove(key);
    expect(bucket.objects.has(key)).toBe(false);
    await expect(store.get(key)).rejects.toThrow(/NoSuchKey/);
  });

  it("purges every version of exactly one key, page by page, for a file that carried a virus", async () => {
    const deleted: { Key?: string; VersionId?: string }[] = [];
    const listed: ListObjectVersionsCommand["input"][] = [];
    const pages = [
      {
        Versions: [{ Key: key, VersionId: "v2" }, { Key: `${key}0`, VersionId: "other" }],
        DeleteMarkers: [{ Key: key, VersionId: "m1" }],
        IsTruncated: true,
        NextKeyMarker: key,
        NextVersionIdMarker: "m1",
      },
      { Versions: [{ Key: key, VersionId: "v1" }], IsTruncated: false },
    ];
    const store = createS3FileStore({
      bucket: "kalendr-files",
      client: {
        async send(command) {
          if (command instanceof ListObjectVersionsCommand) {
            listed.push(command.input);
            return pages.shift();
          }
          if (command instanceof DeleteObjectCommand) deleted.push({ Key: command.input.Key, VersionId: command.input.VersionId });
          return {};
        },
      },
    });
    await store.remove(key, { allVersions: true });
    expect(listed.map((input) => [input.Prefix, input.KeyMarker, input.VersionIdMarker])).toEqual([
      [key, undefined, undefined],
      [key, key, "m1"],
    ]);
    // The longer key that shares the prefix is left alone.
    expect(deleted).toEqual([
      { Key: key, VersionId: "v2" },
      { Key: key, VersionId: "m1" },
      { Key: key, VersionId: "v1" },
      { Key: key, VersionId: undefined },
    ]);
    await expect(store.remove("../x", { allVersions: true })).rejects.toThrow(/Invalid file store key/);
  });

  it("refuses keys that could escape a business's prefix", async () => {
    const bucket = fakeBucket();
    const store = createS3FileStore({ bucket: "kalendr-files", client: bucket.sender });
    for (const bad of ["../clinic_b/x", "tenant/clinic_a/../../x", "/abs", "", "tenant//x"]) {
      await expect(store.put(bad, Buffer.from("x"))).rejects.toThrow(/Invalid file store key/);
      await expect(store.get(bad)).rejects.toThrow(/Invalid file store key/);
    }
    expect(bucket.calls).toHaveLength(0);
  });

  it("names an empty reply instead of returning nothing", async () => {
    const store = createS3FileStore({ bucket: "b", client: { send: async () => ({}) } });
    await expect(store.get(key)).rejects.toThrow(/no body/);
  });
});
