import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ClinicsPage from "@/app/(marketing)/clinics/page";

vi.mock("@/features/marketing/clinics/portal-demo", () => ({ PortalDemo: () => <div data-demo="portal" /> }));

describe("the /clinics page", () => {
  const html = renderToStaticMarkup(<ClinicsPage />);

  it("has one h1 and the key sections", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    for (const heading of ["A portal patients can open.", "Records, without the clutter.", "Doctors, rooms and chairs.", "The waiting room.", "Set up your clinic."]) {
      expect(html).toContain(heading);
    }
  });

  it("says plainly that it is not a full medical records system, and names the real record kinds", () => {
    expect(html).toContain("not a full medical records system");
    for (const kind of ["Visit note", "Report", "Prescription"]) expect(html).toContain(kind);
  });

  it("links to the front desk and setup", () => {
    expect(html).toContain('href="/front-desk"');
    expect(html).toContain('href="/start"');
  });

  it("makes no claim it cannot back up", () => {
    expect(html).not.toMatch(/HIPAA|certified|compliant|testimonial|encrypt|₹\s?\d+\s?\/\s?mo/i);
  });
});
