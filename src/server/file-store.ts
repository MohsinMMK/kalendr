/**
 * Where private files live: record files and business pictures. Every file is encrypted with
 * the business's data key before it gets here, and none is reachable by a public URL: the
 * app reads them back only through its audited routes.
 *
 * Two stores implement the same interface:
 * - disk (KALENDR_FILE_STORE=disk, the default): KALENDR_FILE_STORE_DIR, or .local-files
 *   outside production. One server only.
 * - s3 (KALENDR_FILE_STORE=s3): an S3 or S3-compatible bucket, see file-store-s3.ts.
 *
 * No "server-only" import: the worker reads and writes files too (scanning, re-encryption,
 * moving pictures in).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./api-error";
import { env } from "./env";
import { createS3FileStore } from "./file-store-s3";
import { isFileStoreKey } from "./file-store-keys";

export { fileStoreKey, isFileStoreKey, type FileKind } from "./file-store-keys";

export interface FileStore {
  /** Stores new bytes. Never overwrites: a key is written once. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /**
   * Writes a file's bytes in one step, replacing any earlier bytes at the key: re-encryption
   * under a newer key, and moving pictures in (safe to repeat). A reader sees either the old
   * ciphertext or the new one, and both open, because each names its key version.
   */
  replace(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer>;
  /**
   * Removes the file. In a versioned bucket a plain remove keeps earlier versions until the
   * lifecycle rule expires them, so a mistaken delete can be restored. allVersions removes
   * every stored version too: used for a file found to carry a virus.
   */
  remove(key: string, options?: { allVersions?: boolean }): Promise<void>;
}

export function createDiskFileStore(root: string): FileStore {
  const locate = (key: string) => {
    if (!isFileStoreKey(key)) throw new Error("Invalid file store key");
    return path.join(root, key);
  };
  return {
    async put(key, bytes) {
      const target = locate(key);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
    },
    async replace(key, bytes) {
      const target = locate(key);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      try {
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    get: (key) => readFile(locate(key)),
    remove: (key) => rm(locate(key), { force: true }),
  };
}

function unavailable(): ApiError {
  return new ApiError(503, "records_unavailable", "Records are not set up on this server.");
}

let cachedS3: { signature: string; store: FileStore } | undefined;

/** Production has no default: a server must be told where private files go, and that place must be durable. */
export function getFileStore(): FileStore {
  const settings = env();
  if (settings.KALENDR_FILE_STORE === "s3") {
    if (!settings.S3_BUCKET) throw unavailable();
    const signature = [settings.S3_BUCKET, settings.S3_ENDPOINT, settings.S3_REGION, settings.S3_ACCESS_KEY_ID].join("|");
    if (cachedS3?.signature !== signature) {
      cachedS3 = {
        signature,
        store: createS3FileStore({
          bucket: settings.S3_BUCKET,
          endpoint: settings.S3_ENDPOINT,
          region: settings.S3_REGION ?? "us-east-1",
          forcePathStyle: settings.S3_FORCE_PATH_STYLE === "true",
          accessKeyId: settings.S3_ACCESS_KEY_ID,
          secretAccessKey: settings.S3_SECRET_ACCESS_KEY,
        }),
      };
    }
    return cachedS3.store;
  }
  const root = settings.KALENDR_FILE_STORE_DIR ?? (settings.NODE_ENV === "production" ? null : path.join(process.cwd(), ".local-files"));
  if (!root) throw unavailable();
  return createDiskFileStore(root);
}
