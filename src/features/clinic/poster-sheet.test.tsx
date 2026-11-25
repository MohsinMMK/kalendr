/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { qrCodePath } from "@/lib/check-in";

import { PosterSheet } from "./poster-sheet";

afterEach(cleanup);

const props = {
  businessName: "Smile Dental",
  city: "Andheri West",
  url: "https://kalendr.example/book/smile?utm_source=poster&utm_medium=qr&utm_campaign=share-kit",
  shortUrl: "kalendr.example/b/smile",
  accent: "#0f766e",
  textColor: "#ffffff",
  showBadge: true,
  preview: false,
} as const;

describe("poster sheet", () => {
  it("draws a QR code for the tagged booking link, exactly", () => {
    render(<PosterSheet {...props} size="a4" />);
    const code = screen.getByRole("img", { name: /QR code that opens the booking page of Smile Dental/ });
    expect(code.querySelector("path")?.getAttribute("d")).toBe(qrCodePath(props.url).path);
    expect(screen.getByRole("article", { name: "Poster for Smile Dental" })).toHaveTextContent("Andheri West");
    expect(screen.getByText("kalendr.example/b/smile")).toBeInTheDocument();
  });

  it("sizes the paper for A4 and A5 and offers both", () => {
    const { container, rerender } = render(<PosterSheet {...props} size="a4" />);
    expect(container.querySelector("style")?.textContent).toContain("size: A4 portrait");
    expect(screen.getByRole("link", { name: "A4" })).toHaveAttribute("aria-current", "page");
    rerender(<PosterSheet {...props} size="a5" />);
    expect(container.querySelector("style")?.textContent).toContain("size: A5 portrait");
    expect(screen.getByRole("link", { name: "A5" })).toHaveAttribute("aria-current", "page");
  });

  it("leaves out the Kalendr badge when the plan hides it, and says when it is only a sample", () => {
    render(<PosterSheet {...props} size="a4" showBadge={false} preview />);
    expect(screen.queryByText("Bookings by Kalendr")).not.toBeInTheDocument();
    expect(screen.getByText(/A sample/)).toBeInTheDocument();
  });
});
