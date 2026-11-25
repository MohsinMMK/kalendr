import { describe, expect, it } from "vitest";

import { blockHint, contactKeys, emailDomainOf, normalizeBlockValue, normalizeDomainInput, normalizeEmailForBlock } from "./spam-contact";

describe("normalizeEmailForBlock", () => {
  it("lower-cases and trims", () => {
    expect(normalizeEmailForBlock("  Raj@Example.COM ")).toBe("raj@example.com");
  });

  it("treats dots and +tags on Gmail as the same inbox", () => {
    for (const variant of ["r.a.j+x@gmail.com", "raj@gmail.com", "R.AJ+spam+more@googlemail.com", "raj+1@GMAIL.com"]) {
      expect(normalizeEmailForBlock(variant)).toBe("raj@gmail.com");
    }
  });

  it("leaves dots alone on other providers", () => {
    expect(normalizeEmailForBlock("r.a.j@example.com")).toBe("r.a.j@example.com");
  });

  it("returns null for something that is not an address", () => {
    expect(normalizeEmailForBlock("not an email")).toBeNull();
    expect(normalizeEmailForBlock("+@gmail.com")).toBeNull();
  });
});

describe("domains", () => {
  it("finds the domain of an address and folds googlemail into gmail", () => {
    expect(emailDomainOf("a@Glow.Example")).toBe("glow.example");
    expect(emailDomainOf("a@googlemail.com")).toBe("gmail.com");
  });

  it("accepts a domain, an @domain or a full address from staff", () => {
    expect(normalizeDomainInput("@Glow.Example")).toBe("glow.example");
    expect(normalizeDomainInput("someone@glow.example")).toBe("glow.example");
    expect(normalizeDomainInput("nope")).toBeNull();
  });
});

describe("contactKeys and hints", () => {
  it("gives the address, its domain and the phone", () => {
    const keys = contactKeys({ email: "R.A.J+x@gmail.com", phone: "98765 43210" });
    expect(keys).toEqual([
      { kind: "email", value: "raj@gmail.com" },
      { kind: "email_domain", value: "gmail.com" },
      { kind: "phone", value: "919876543210" },
    ]);
  });

  it("normalises phones to one form", () => {
    expect(normalizeBlockValue("phone", "+91 98765-43210")).toBe("919876543210");
    expect(normalizeBlockValue("phone", "09876543210")).toBe("919876543210");
  });

  it("masks hints so the value cannot be rebuilt", () => {
    expect(blockHint("email", "raj@gmail.com")).toBe("r•••@gmail.com");
    expect(blockHint("phone", "919876543210")).toBe("•••• 3210");
    expect(blockHint("email_domain", "glow.example")).toBe("@glow.example");
  });
});
