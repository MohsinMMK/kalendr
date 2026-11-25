import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { resolveBusinessProfile } from "@/lib/terminology";

import { SpecialLinkUnavailable } from "./special-link-unavailable";

const profile = resolveBusinessProfile({ businessType: "salon" });

describe("SpecialLinkUnavailable", () => {
  afterEach(cleanup);

  it("says the link was used and shows the business's phone", () => {
    render(<SpecialLinkUnavailable clinicName="Glow Salon" phone="+91 98765 43210" profile={profile} />);
    expect(screen.getByRole("heading", { name: "This link has already been used." })).toBeInTheDocument();
    expect(screen.getByText(/Contact the business to book\./)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /\+91 98765 43210/ })[0]).toHaveAttribute("href", "tel:+919876543210");
  });

  it("still reads well without a phone", () => {
    render(<SpecialLinkUnavailable profile={profile} />);
    expect(screen.getByText("Contact the business to book.")).toBeInTheDocument();
    expect(screen.queryByText(/You can call/)).not.toBeInTheDocument();
  });
});
