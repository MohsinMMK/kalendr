/** Object keys for the file store, shared by the disk and S3 stores. */
export type FileKind = "record" | "media" | "export" | "import" | "invoice";

/** Keys written before feature 10 ("{tenant}/{id}") and since ("tenant/{tenant}/{kind}/{id}"). */
const keyPattern = /^(?:[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|tenant\/[A-Za-z0-9_-]+\/(?:record|media|export|import|invoice)\/[A-Za-z0-9_-]+)$/;

export function isFileStoreKey(key: string): boolean {
  return keyPattern.test(key);
}

/** tenant/{tenantId}/{kind}/{id}. The business id is part of every key, so one business's files are one prefix. */
export function fileStoreKey(tenantId: string, kind: FileKind, id: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
  return `tenant/${safe(tenantId)}/${kind}/${safe(id)}`;
}
