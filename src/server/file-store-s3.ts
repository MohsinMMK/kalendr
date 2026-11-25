/**
 * The S3 file store. Objects are already encrypted with the business's data key before
 * upload, so the bucket (and anyone who can read it) only ever holds ciphertext.
 *
 * The bucket is private: versioning on, every public-access setting blocked, and the app
 * never creates public or pre-signed links. Downloads go through the app's audited routes.
 * scripts/s3-bucket.mjs sets the bucket up and checks it.
 *
 * Works with AWS S3 and S3-compatible stores (MinIO locally, with S3_FORCE_PATH_STYLE=true).
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { FileStore } from "./file-store";
import { isFileStoreKey } from "./file-store-keys";

/** The part of S3Client this store uses, so tests can pass a stub. */
export interface S3Sender {
  send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand | ListObjectVersionsCommand): Promise<unknown>;
}

export interface S3FileStoreOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  client?: S3Sender;
}

function checkKey(key: string): string {
  if (!isFileStoreKey(key)) throw new Error("Invalid file store key");
  return key;
}

export function createS3Client(options: Omit<S3FileStoreOptions, "bucket" | "client">): S3Client {
  return new S3Client({
    region: options.region ?? "us-east-1",
    endpoint: options.endpoint,
    forcePathStyle: options.forcePathStyle,
    credentials: options.accessKeyId && options.secretAccessKey
      ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
      : undefined,
  });
}

export function createS3FileStore(options: S3FileStoreOptions): FileStore {
  const client: S3Sender = options.client ?? createS3Client(options);
  const bucket = options.bucket;
  return {
    async put(key, bytes) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: checkKey(key),
        Body: bytes,
        ContentLength: bytes.byteLength,
        // Ciphertext: nothing about the type or name of the file is visible in the bucket.
        ContentType: "application/octet-stream",
        // A key is written once; a second write to it is a bug, not an update.
        IfNoneMatch: "*",
      }));
    },
    async replace(key, bytes) {
      // A PUT is atomic. In a versioned bucket the old ciphertext stays as a noncurrent version
      // until the lifecycle rule expires it; its key version is only retired, never destroyed.
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: checkKey(key),
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: "application/octet-stream",
      }));
    },
    async get(key) {
      const result = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: checkKey(key) }))) as {
        Body?: { transformToByteArray(): Promise<Uint8Array> };
      };
      if (!result.Body) throw new Error("The file store returned no body");
      return Buffer.from(await result.Body.transformToByteArray());
    },
    async remove(key, options) {
      checkKey(key);
      if (!options?.allVersions) {
        // In a versioned bucket this adds a delete marker; the old version expires by the bucket's lifecycle rule.
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return;
      }
      // Every version and delete marker of exactly this key (the prefix also matches longer keys).
      // Needs s3:ListBucketVersions and s3:DeleteObjectVersion.
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      do {
        const page = (await client.send(new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }))) as {
          Versions?: { Key?: string; VersionId?: string }[];
          DeleteMarkers?: { Key?: string; VersionId?: string }[];
          IsTruncated?: boolean;
          NextKeyMarker?: string;
          NextVersionIdMarker?: string;
        };
        for (const entry of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
          if (entry.Key !== key || !entry.VersionId) continue;
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: entry.VersionId }));
        }
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (keyMarker);
      // An unversioned bucket lists the object with VersionId "null", deleted above; this covers a store that lists nothing.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
