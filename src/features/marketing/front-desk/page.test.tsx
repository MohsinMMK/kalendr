import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/marketing/front-desk/today-demo", () => ({ TodayDemo: () => <figure aria-label="demo" /> }));

import FrontDeskPage, { metadata } from "@/app/(marketing)/front-desk/page";

describe("the front desk page", () => {
  const html = renderToStaticMarkup(<FrontDeskPage />);

  it("has one h1 and the section headings in order", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Run the day.");
    const headings = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]);
    expect(headings).toEqual([
      "Today and the schedule.",
      "Walk-ins and the queue.",
      "A smart waitlist.",
      "Customer profiles.",
      "The team.",
      "Give your front desk a calmer day.",
    ]);
  });

  it("uses the product's words and links to set-up", () => {
    for (const word of ["Add walk-in", "Up next", "Waiting", "Take this time", "Needs attention", "Approve", "Anyone available"]) expect(html).toContain(word);
    expect(html).toContain('href="/start"');
  });

  it("states delivery and class limits honestly", () => {
    expect(html).toContain("once you connect");
    expect(html).toContain("Seats are not charged yet");
    expect(html).toContain("not a full medical records system");
  });

  it("makes no forbidden claim", () => {
    expect(html).not.toMatch(/HIPAA|certified|compliant|testimonial|seamless|revolutionary|all-in-one|AI-powered|₹\s?\d+\s?\/\s?mo/i);
  });

  it("sets its metadata", () => {
    expect(metadata.description).toBeTruthy();
    expect(metadata.title).toBe("Front desk");
  });
});
