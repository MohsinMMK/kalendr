import { describe, expect, it } from "vitest";

import { maskContact, normalizeContact, normalizePhone } from "./patient-contact";

describe("patient contact matching", () => {
  it("treats the common ways of writing an Indian mobile as one number", () => {
    for (const written of ["98450 12345", "098450 12345", "+91 98450 12345", "91-98450-12345"]) {
      expect(normalizePhone(written)).toBe("919845012345");
    }
  });

  it("canonicalises email and rejects what can't be a contact", () => {
    expect(normalizeContact("email", "  Ananya.Rao@Example.com ")).toBe("ananya.rao@example.com");
    expect(normalizeContact("email", "not-an-email")).toBeNull();
    expect(normalizeContact("phone", "12345")).toBeNull();
    expect(normalizeContact("phone", "1".repeat(16))).toBeNull();
  });

  it("masks without revealing the whole contact", () => {
    expect(maskContact("phone", "919845012345")).toBe("•••• 2345");
    expect(maskContact("email", "ananya.rao@example.com")).toBe("a•••@example.com");
  });
});
