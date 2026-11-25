/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { importLimits } from "./contracts";
import { readImportUpload } from "./upload";

function upload(parts: Array<[string, string | File]>, headers: Record<string, string> = {}): Request {
  const form = new FormData();
  for (const [name, value] of parts) form.append(name, value);
  // A real multipart body, as a browser would send it.
  const probe = new Request("http://localhost/api/staff/imports", { method: "POST", body: form });
  return new Request("http://localhost/api/staff/imports", { method: "POST", body: probe.body, headers: { "content-type": probe.headers.get("content-type") ?? "", ...headers }, duplex: "half" } as RequestInit);
}

describe("readImportUpload", () => {
  it("reads the file and the kind", async () => {
    const result = await readImportUpload(upload([["kind", "customers"], ["file", new File(["Name,Phone\nAsha,1\n"], "people.csv", { type: "text/csv" })]]));
    expect(result.kind).toBe("customers");
    expect(new TextDecoder().decode(result.bytes)).toBe("Name,Phone\nAsha,1\n");
  });

  it("cuts the body off past the limit, whatever Content-Length said", async () => {
    const big = new File([new Uint8Array(importLimits.maxBytes + 200 * 1024)], "big.csv");
    await expect(readImportUpload(upload([["kind", "customers"], ["file", big]]))).rejects.toMatchObject({ status: 413, code: "file_too_large" });
    const liar = new File([new Uint8Array(importLimits.maxBytes + 200 * 1024)], "big.csv");
    await expect(readImportUpload(upload([["file", liar]], { "content-length": "100" }))).rejects.toMatchObject({ status: 413 });
  });

  it("refuses a declared size that is already too big, before reading", async () => {
    const request = upload([["file", new File(["x"], "a.csv")]], { "content-length": String(importLimits.maxBytes * 2) });
    await expect(readImportUpload(request)).rejects.toMatchObject({ status: 413 });
  });

  it("refuses the wrong content type, a missing file and a broken form", async () => {
    await expect(readImportUpload(new Request("http://localhost/x", { method: "POST", body: "a,b", headers: { "content-type": "text/csv" } }))).rejects.toMatchObject({ status: 415 });
    await expect(readImportUpload(upload([["kind", "customers"]]))).rejects.toMatchObject({ status: 400 });
    await expect(readImportUpload(new Request("http://localhost/x", { method: "POST", body: "garbage", headers: { "content-type": "multipart/form-data; boundary=zzz" } }))).rejects.toMatchObject({ status: 400 });
  });
});
