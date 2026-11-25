export const maxRecordFileBytes = 15 * 1_024 * 1_024;
export const maxRecordBodyLength = 20_000;
export const recordFileAccept = "application/pdf,image/jpeg,image/png";

export type RecordContentType = "application/pdf" | "image/jpeg" | "image/png";

/**
 * Trusts the file's own bytes, never its name or the browser's claim. Only types that can't run script when
 * opened from Kalendr's origin are accepted, which is why Word files and SVGs aren't on the list.
 */
export function detectRecordContentType(bytes: Uint8Array): RecordContentType | null {
  const startsWith = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  return null;
}

export function cleanFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 160);
  return cleaned || "document";
}

export function fileSizeLabel(bytes: number): string {
  if (bytes < 1_024 * 1_024) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
