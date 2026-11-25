import { describe, expect, it } from "vitest";

import { cleanFileName, detectRecordContentType, fileSizeLabel } from "./record-files";

const ascii = (text: string) => new TextEncoder().encode(text);

describe("record file checks", () => {
  it("recognises allowed types from their bytes", () => {
    expect(detectRecordContentType(ascii("%PDF-1.7 ..."))).toBe("application/pdf");
    expect(detectRecordContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectRecordContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
  });

  it("rejects anything that could run script, whatever it claims to be", () => {
    expect(detectRecordContentType(ascii("<svg onload=alert(1)>"))).toBeNull();
    expect(detectRecordContentType(ascii("<html><script></script>"))).toBeNull();
    expect(detectRecordContentType(new Uint8Array())).toBeNull();
    expect(detectRecordContentType(ascii("%PD"))).toBeNull();
  });

  it("strips path and header tricks from file names", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("....etcpasswd");
    expect(cleanFileName("report\r\nSet-Cookie: x.pdf")).toBe("reportSet-Cookie: x.pdf");
    expect(cleanFileName("  \u0000 ")).toBe("document");
    expect(cleanFileName("x".repeat(400))).toHaveLength(160);
  });

  it("labels sizes", () => {
    expect(fileSizeLabel(10)).toBe("1 KB");
    expect(fileSizeLabel(2_048)).toBe("2 KB");
    expect(fileSizeLabel(3 * 1_024 * 1_024)).toBe("3.0 MB");
  });
});
