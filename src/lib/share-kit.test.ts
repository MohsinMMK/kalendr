import { describe, expect, it } from "vitest";

import { emailSignatureLine, parsePosterSize, posterPath, shareChannels, shareLinks } from "./share-kit";

describe("share kit links", () => {
  const links = shareLinks("https://kalendr.example/", "smile-dental");

  it("makes one booking link per place, each with its own source tag", () => {
    expect(links.map((link) => link.id)).toEqual(shareChannels.map((channel) => channel.id));
    const sources = links.map((link) => new URL(link.url).searchParams.get("utm_source"));
    expect(new Set(sources).size).toBe(links.length);
    expect(sources).toEqual(expect.arrayContaining(["instagram", "whatsapp", "google", "email", "poster"]));
  });

  it("opens the booking page, not some other address", () => {
    for (const link of links) {
      const url = new URL(link.url);
      expect(url.origin).toBe("https://kalendr.example");
      expect(url.pathname).toBe("/book/smile-dental");
      expect(url.searchParams.get("utm_campaign")).toBe("share-kit");
    }
  });

  it("can point at one service and uses the business's own address when given", () => {
    const own = shareLinks("https://book.smile.in", "smile-dental", "check-up");
    expect(new URL(own[0]!.url).origin).toBe("https://book.smile.in");
    expect(new URL(own[0]!.url).pathname).toBe("/book/smile-dental/check-up");
  });

  it("writes a plain signature line", () => {
    expect(emailSignatureLine("Smile Dental", "https://x.test/book/s")).toBe("Book an appointment with Smile Dental: https://x.test/book/s");
  });

  it("reads the poster size, defaulting to A4", () => {
    expect(parsePosterSize("a5")).toBe("a5");
    expect(parsePosterSize("a3")).toBe("a4");
    expect(parsePosterSize(undefined)).toBe("a4");
    expect(posterPath("a5")).toBe("/print/poster?size=a5");
  });
});
