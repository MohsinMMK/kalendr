import { ApiError } from "@/server/api-error";

import { importLimits } from "./contracts";
import { fileErrorText } from "./reasons";

/** Room for the form's own boundaries and the "kind" field around the file. */
const OVERHEAD = 64 * 1024;

/**
 * Reads the upload's multipart body with a hard cap: the stream is cut off the moment it passes the limit, so an
 * oversized file is never held in memory whole, whatever its Content-Length claimed.
 */
export async function readImportUpload(request: Request): Promise<{ bytes: Uint8Array; kind: FormDataEntryValue | null }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new ApiError(415, "unsupported_media_type", "Send the file as a form upload.");
  }
  const limit = importLimits.maxBytes + OVERHEAD;
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  const tooLarge = () => new ApiError(413, "file_too_large", fileErrorText("file_too_large"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  if (!request.body) throw new ApiError(400, "validation_error", "Choose a file to upload.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new ApiError(400, "validation_error", "Choose a file to upload.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "validation_error", "Choose a file to upload.");
  return { bytes: new Uint8Array(await file.arrayBuffer()), kind: form.get("kind") };
}
