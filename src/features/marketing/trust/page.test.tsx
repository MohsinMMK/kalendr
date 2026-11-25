import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/marketing/trust/access-demo", () => ({ AccessDemo: () => <div data-demo="access" /> }));

import TrustPage, { metadata } from "@/app/(marketing)/trust/page";

describe("the /trust page", () => {
  const html = renderToStaticMarkup(<TrustPage />);

  it("has one h1 and the section headings in order", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Your data stays yours.");
    const at = [
      "Each business&#x27;s data stays its own.",
      "The right people see the right pages.",
      "Sign-in.",
      "See who changed what, and when.",
      "Privacy tools for your customers.",
      "For developers.",
    ].map((heading) => html.indexOf(heading));
    expect(at.every((index) => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("links to the developers reference and the sign-up", () => {
    expect(html).toContain('href="/developers"');
    expect(html).toContain('href="/start"');
  });

  it("states row-level security plainly and names Google and Microsoft only as once connected", () => {
    expect(html).toContain("row-level security");
    expect(html).toMatch(/Once you connect your Google or Microsoft account/);
  });

  it("lists every action that asks for a recent second step", () => {
    expect(html).toContain("Changing roles, payment settings or API keys, exporting data or deleting a customer");
  });

  it("makes no forbidden claim", () => {
    expect(html).not.toMatch(/HIPAA|certified|compliant|testimonial|DPDP|SOC 2|ISO 27|₹\s?\d+\s?\/\s?mo/i);
  });

  it("has page metadata", () => {
    expect(metadata.title).toBe("Privacy and security");
  });
});
