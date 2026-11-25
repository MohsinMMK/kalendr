/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { defaultNotice, noticeFromStored, noticeLanguageFor, NOTICE_VERSION } from "./notice";
import { consentPurposes } from "./rules";

describe("privacy notice", () => {
  it("has separate plain-language text for every purpose, in English and Hindi", () => {
    for (const language of ["en", "hi"]) {
      const notice = defaultNotice(language);
      expect(notice.version).toBe(NOTICE_VERSION);
      expect(notice.isDefault).toBe(true);
      for (const purpose of consentPurposes) {
        expect(notice.purposes[purpose].label.length).toBeGreaterThan(2);
        expect(notice.purposes[purpose].text.length).toBeGreaterThan(10);
      }
    }
    expect(defaultNotice("hi").title).not.toBe(defaultNotice("en").title);
  });

  it("falls back to English for an unknown language and reads regional codes", () => {
    expect(noticeLanguageFor("fr")).toBe("en");
    expect(noticeLanguageFor("hi-IN")).toBe("hi");
    expect(noticeLanguageFor(null)).toBe("en");
  });

  it("answers a bad query string with a 400 and field errors, not a server fault", async () => {
    const { z } = await import("zod");
    const { parseQuery } = await import("@/server/http");
    const schema = z.object({ clinic: z.string().min(1), language: z.string().max(10).optional() });
    expect(parseQuery(new Request("https://kalendr.example/api/public/privacy-notice?clinic=lotus&language=hi"), schema)).toEqual({ clinic: "lotus", language: "hi" });
    expect(() => parseQuery(new Request("https://kalendr.example/api/public/privacy-notice"), schema)).toThrowError(expect.objectContaining({ status: 400, code: "validation_error" }));
  });

  it("never uses the words the product must not claim", () => {
    for (const language of ["en", "hi"]) expect(JSON.stringify(defaultNotice(language))).not.toMatch(/complian/i);
  });

  it("reads a business's own text and keeps the built-in text for anything missing or malformed", () => {
    const notice = noticeFromStored({
      version: "2027-01",
      language: "en",
      purposes: { title: "Our promise", purposes: { marketing_messages: { label: "Offers", text: "Only if you say yes." }, reviews: "broken" }, paragraphs: ["One.", 7] },
    });
    expect(notice).toMatchObject({ version: "2027-01", isDefault: false, title: "Our promise", paragraphs: ["One."] });
    expect(notice.purposes.marketing_messages.label).toBe("Offers");
    expect(notice.purposes.reviews.label).toBe(defaultNotice("en").purposes.reviews.label);
  });
});
