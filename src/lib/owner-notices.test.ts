import { describe, expect, it } from "vitest";

import { ownerNoticeContent, ownerNoticeKinds } from "./owner-notices";

const fields = { hostname: "book.acme.test", settingsUrl: "https://app.example/settings", dashboardUrl: "https://app.example/dashboard", bookingUrl: "https://app.example/book/acme", done: 2, total: 8 };

describe("owner notices", () => {
  it.each(ownerNoticeKinds)("%s reads as plain sentences with one button", (kind) => {
    const content = ownerNoticeContent(kind, fields);
    expect(content.subject.length).toBeGreaterThan(8);
    expect(content.paragraphs.length).toBeGreaterThanOrEqual(1);
    expect(content.button.url).toMatch(/^https:\/\//);
    // Nothing about a customer, and no jargon.
    expect(JSON.stringify(content)).not.toMatch(/undefined|null|CNAME record id|\bpatient\b/i);
  });

  it("tells the owner how far they have got, and shows the link to share", () => {
    expect(ownerNoticeContent("onboarding_day1", fields).paragraphs[0]).toContain("2 of 8");
    expect(ownerNoticeContent("onboarding_day3", fields).paragraphs.join(" ")).toContain("https://app.example/book/acme");
    expect(ownerNoticeContent("domain_stopped", fields).subject).toContain("book.acme.test");
  });
});
