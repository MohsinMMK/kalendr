import { describe, expect, it } from "vitest";

import { newVerificationToken, verifyRecordValue } from "@/lib/domain-rules";

import { cnameMatches, hashToken, judgeDomain, txtMatchesHash } from "./verify";

describe("address verification", () => {
  const token = newVerificationToken();
  const hash = hashToken(token);

  it("makes 256-bit tokens and stores only their hash", () => {
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(newVerificationToken()).not.toBe(token);
  });

  it("matches the TXT value against the stored hash", () => {
    expect(txtMatchesHash([verifyRecordValue(token)], hash)).toBe(true);
    expect(txtMatchesHash(["v=spf1 -all", `  ${verifyRecordValue(token)} `], hash)).toBe(true);
    expect(txtMatchesHash([verifyRecordValue(newVerificationToken())], hash)).toBe(false);
    expect(txtMatchesHash([token], hash)).toBe(false);
    expect(txtMatchesHash([verifyRecordValue(token)], null)).toBe(false);
    expect(txtMatchesHash([verifyRecordValue(token)], "not-a-hash")).toBe(false);
  });

  it("ignores letter case and a trailing dot in the CNAME", () => {
    expect(cnameMatches(["Edge.Kalendr.Example."], "edge.kalendr.example")).toBe(true);
    expect(cnameMatches(["other.example."], "edge.kalendr.example")).toBe(false);
    expect(cnameMatches([], "edge.kalendr.example")).toBe(false);
    expect(cnameMatches(["edge.kalendr.example"], "")).toBe(false);
  });

  it("judges a pair of lookups, and never reads a failed lookup as a missing record", () => {
    const target = "edge.kalendr.example";
    expect(judgeDomain({ cname: [target], txt: [verifyRecordValue(token)] }, target, hash)).toBe("ok");
    expect(judgeDomain({ cname: [], txt: [verifyRecordValue(token)] }, target, hash)).toBe("cname_missing");
    expect(judgeDomain({ cname: [target], txt: [] }, target, hash)).toBe("txt_missing");
    expect(judgeDomain({ cname: [], txt: [] }, target, hash)).toBe("both_missing");
    expect(judgeDomain({ cname: null, txt: [] }, target, hash)).toBe("lookup_failed");
    expect(judgeDomain({ cname: [target], txt: null }, target, hash)).toBe("lookup_failed");
  });
});
