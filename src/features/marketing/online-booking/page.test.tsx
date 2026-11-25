import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/marketing/online-booking/booking-demo", () => ({ BookingDemo: () => <div data-demo="booking" /> }));

import OnlineBookingPage from "@/app/(marketing)/online-booking/page";

describe("the /online-booking page", () => {
  const html = renderToStaticMarkup(<OnlineBookingPage />);

  it("has one h1 and the section headings in order", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Customers book");
    const at = ["booking-page", "website", "questions", "manage", "closing"].map((id) => html.indexOf(`id="${id}-title"`));
    expect(at.every((index) => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("links to the embed demo, the developer reference and set-up", () => {
    expect(html).toContain('href="/embed-demo"');
    expect(html).toContain('href="/developers"');
    expect(html).toContain('href="/start"');
  });

  it("shows the real embed attributes", () => {
    for (const attribute of ["data-kalendr-business", "data-kalendr-mode", "data-kalendr-mount", "data-kalendr-label"]) {
      expect(html).toContain(attribute);
    }
    expect(html).toContain("kalendr:booked");
  });

  it("uses the product's own words in the page text", () => {
    expect(html).toContain("Manage appointment");
    expect(html).toContain("Add to calendar");
  });

  it("names payments only as needing an account", () => {
    expect(html).toContain("once you connect Razorpay or Stripe");
  });

  it("makes no forbidden claim", () => {
    expect(html).not.toMatch(/HIPAA|certified|compliant|testimonial|₹\s?\d+\s?\/\s?mo|seamless|revolutionary|all-in-one|AI-powered/i);
  });
});
