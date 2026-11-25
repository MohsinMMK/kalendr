import { describe, expect, it } from "vitest";

import { domainState, normaliseHostname, normaliseOrigin, verifyRecordName, verifyRecordValue } from "./domain-rules";

const rules = { reservedHosts: ["kalendr.example", "edge.kalendr.example"] };

describe("own web address rules", () => {
  it("normalises what an owner types", () => {
    expect(normaliseHostname("https://Book.TheirBusiness.com/", rules)).toBe("book.theirbusiness.com");
    expect(normaliseHostname("  book.theirbusiness.com.  ", rules)).toBe("book.theirbusiness.com");
    expect(normaliseHostname("book.tést.com", rules)).toBe("book.xn--tst-bma.com");
  });

  it("refuses what cannot be served", () => {
    for (const bad of ["", "theirbusiness.com", "localhost", "127.0.0.1", "book.thing.local", "a b.example.com", "book.example.com:8080", "user@book.example.com", "-bad.example.com", "book..example.com", "kalendr.example", "x.kalendr.example", "x.edge.kalendr.example"]) {
      expect(normaliseHostname(bad, rules), bad).toBeNull();
    }
  });

  it("puts the verification record on its own name, away from the CNAME", () => {
    expect(verifyRecordName("book.example.com")).toBe("_kalendr-verify.book.example.com");
    expect(verifyRecordValue("abc")).toBe("kalendr-verify=abc");
  });

  it("accepts only plain https origins for embedding", () => {
    expect(normaliseOrigin("https://www.Clinic.com")).toBe("https://www.clinic.com");
    expect(normaliseOrigin("www.clinic.com")).toBe("https://www.clinic.com");
    expect(normaliseOrigin("https://www.clinic.com:8443/path?x=1")).toBe("https://www.clinic.com:8443");
    for (const bad of ["http://clinic.com", "https://user:pw@clinic.com", "https://*.clinic.com", "https://a.com; script-src *", "javascript:alert(1)", "https://clinic.com, https://evil.com", "", "ftp://x.com"]) {
      expect(normaliseOrigin(bad), bad).toBeNull();
    }
  });

  it("names the four states the screen shows", () => {
    expect(domainState({ status: "pending", missingSince: null })).toBe("pending");
    expect(domainState({ status: "active", missingSince: null })).toBe("live");
    expect(domainState({ status: "active", missingSince: new Date() })).toBe("warning");
    expect(domainState({ status: "failed", missingSince: null })).toBe("failed");
  });
});
