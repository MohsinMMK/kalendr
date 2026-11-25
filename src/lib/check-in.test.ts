import { describe, expect, it } from "vitest";

import { bookingReference, checkInPath, qrCodePath } from "./check-in";

describe("check-in", () => {
  it("points the QR at the check-in page for the booking", () => {
    expect(checkInPath("abc_123-XYZ")).toBe("/check-in/abc_123-XYZ");
  });

  it("makes a short reference code from the booking id", () => {
    expect(bookingReference("3f9ac21b-1111-2222-3333-444455556666")).toBe("3F9A-C21B");
    expect(bookingReference("abc")).toBe("ABC");
  });

  it("draws a square QR with a quiet border", () => {
    const { size, path } = qrCodePath("https://kalendr.app/check-in/abc_123-XYZ");
    expect(size).toBeGreaterThanOrEqual(25);
    expect(path).toMatch(/^M\d+ \d+h1v1h-1z/);
    // The border stays blank: no square starts in the first two rows or columns.
    expect(path).not.toMatch(/M[01] /);
    expect(path).not.toMatch(/M\d+ [01]h/);
  });
});
