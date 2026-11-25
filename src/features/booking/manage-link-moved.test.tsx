// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ManageLinkMoved } from "./manage-link-moved";

afterEach(cleanup);

describe("the landing for an old reschedule link", () => {
  it("shows the new time and a Book again button, and never a way to manage the booking", () => {
    render(<ManageLinkMoved businessName="Lotus" serviceName="Haircut" newTime={{ startsAt: "2026-12-02T10:30:00.000Z", timezone: "UTC" }} bookAgainPath="/book/lotus/haircut" />);
    expect(screen.getByRole("heading", { name: /was moved/i })).toBeInTheDocument();
    expect(screen.getByTestId("moved-new-time")).toHaveTextContent(/2 December/);
    expect(screen.getByRole("link", { name: "Book again" })).toHaveAttribute("href", "/book/lotus/haircut");
    expect(screen.queryByRole("button", { name: /cancel|reschedule/i })).not.toBeInTheDocument();
  });

  it("offers Book again alone when the customer no longer holds a time", () => {
    render(<ManageLinkMoved businessName="Lotus" serviceName="Haircut" newTime={null} bookAgainPath="/book/lotus/haircut" />);
    expect(screen.queryByTestId("moved-new-time")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Book again" })).toBeInTheDocument();
  });

  it("hides Book again when the service switched it off", () => {
    render(<ManageLinkMoved businessName="Lotus" serviceName="Haircut" newTime={null} bookAgainPath={null} />);
    expect(screen.queryByRole("link", { name: "Book again" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to your account" })).toBeInTheDocument();
  });
});
