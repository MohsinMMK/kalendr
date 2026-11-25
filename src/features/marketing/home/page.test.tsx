import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/marketing/home/hero-demo", () => ({ HeroDemo: () => <figure aria-label="demo" /> }));

import HomePage, { metadata } from "@/app/(marketing)/page";
import { marketingPages } from "@/features/marketing/site-nav";

describe("the home page", () => {
  const html = renderToStaticMarkup(<HomePage />);

  it("has one h1 and the section headings in order", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Your bookings.");
    const headings = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]);
    expect(headings).toEqual(["One product for the whole day.", "How it starts.", "Your words.", "A few answers.", "Ready for your next booking?"]);
  });

  it("links to every product page and to set-up", () => {
    for (const page of marketingPages) expect(html).toContain(`href="${page.href}"`);
    expect(html).toContain('href="/start"');
    expect(html).toContain('href="/online-booking"');
    expect(html).toContain("Set up your business");
  });

  it("names the business types' own words", () => {
    expect(html).toContain("Stylists");
    expect(html).toContain("Tutors");
    expect(html).toContain("Doctors");
  });

  it("says Kalendr is not a full medical records system and makes no forbidden claim", () => {
    expect(html).toContain("not a full medical records system");
    expect(html).not.toMatch(/HIPAA|certified|compliant|testimonial|₹\s?\d+\s?\/\s?mo/i);
  });

  it("sets its metadata", () => {
    expect(metadata.description).toBeTruthy();
    expect(JSON.stringify(metadata.title)).toContain("Online booking and scheduling for any business");
  });
});
