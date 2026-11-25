import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import IndustriesPage from "@/app/(marketing)/industries/page";
import { businessTypeIds, businessTypes } from "@/lib/business-types";

vi.mock("@/features/marketing/industries/industries-demo", () => ({ IndustriesDemo: () => <div data-demo="industries" /> }));

describe("the /industries page", () => {
  const html = renderToStaticMarkup(<IndustriesPage />);

  it("has one h1 and the key sections", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("One product.");
    for (const heading of ["Pick your business.", "Then make it yours.", "A room or a chair, booked with the person.", "Set it up in your words."]) {
      expect(html).toContain(heading);
    }
  });

  it("shows every business type with its own three words", () => {
    for (const id of businessTypeIds) {
      expect(html).toContain(businessTypes[id].label);
      expect(html).toContain(`Words for ${businessTypes[id].label}`);
    }
    expect(html).toContain("Patients");
    expect(html).toContain("Visits");
    expect(html).toContain("Students");
    expect(html).toContain("Sessions");
  });

  it("links to setup", () => {
    expect(html).toContain('href="/start"');
  });

  it("makes no claim it cannot back up", () => {
    expect(html).not.toMatch(/HIPAA|certified|compliant|testimonial|₹\s?\d+\s?\/\s?mo/i);
  });
});
