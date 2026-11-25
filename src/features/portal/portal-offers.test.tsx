/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { customerPackage, membershipView } from "@/test/offers-fixtures";

import { PortalOffers } from "./portal-offers";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const answer = (people: unknown[]) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { people } }) }) as Response);
const person = (patch: Record<string, unknown> = {}) => ({ clinicSlug: "lotus", clinicName: "Lotus Dental", patientId: "pat1", name: "Meera Joshi", offers: { packages: [customerPackage()], memberships: [membershipView()] }, ...patch });

describe("packages in the customer portal", () => {
  it("shows balance, expiry and status for each package, and memberships, per business", async () => {
    vi.stubGlobal("fetch", answer([person(), person({ clinicSlug: "glow", clinicName: "Glow Studio", patientId: "pat9", offers: { packages: [customerPackage({ id: "x", name: "Facial pack", status: "expired", remaining: 1, creditsTotal: 4 })], memberships: [] } })]));
    render(<PortalOffers preview={false} />);
    const section = await screen.findByRole("region", { name: "Packages" });
    const lotus = within(section).getByRole("list", { name: "Packages at Lotus Dental" });
    expect(within(lotus).getByText("7 of 10 left")).toBeInTheDocument();
    expect(within(lotus).getByText(/Valid until 30 March/)).toBeInTheDocument();
    expect(within(lotus).getByText("Active")).toBeInTheDocument();
    const glow = within(section).getByRole("list", { name: "Packages at Glow Studio" });
    expect(within(glow).getByText("Expired")).toBeInTheDocument();
    expect(within(glow).getByText(/Ended on/)).toBeInTheDocument();
    const memberships = within(section).getByRole("list", { name: "Memberships at Lotus Dental" });
    expect(within(memberships).getByText("Gold membership")).toBeInTheDocument();
    expect(within(memberships).getByText("Active")).toBeInTheDocument();
    expect(within(section).getByText(/Lotus Dental · Meera Joshi/)).toBeInTheDocument();
    expect(within(section).queryByRole("button")).not.toBeInTheDocument();
  });

  it("says when a membership payment failed and when its benefits stop", async () => {
    vi.stubGlobal("fetch", answer([person({ offers: { packages: [], memberships: [membershipView({ status: "past_due", graceEndsAt: "2026-11-27T09:00:00.000Z" })] } })]));
    render(<PortalOffers preview={false} />);
    expect(await screen.findByText("Payment failed – benefits stop on 27 November")).toBeInTheDocument();
  });

  it("hides the whole section when the customer holds nothing", async () => {
    const fetchMock = answer([person({ offers: { packages: [], memberships: [] } })]);
    vi.stubGlobal("fetch", fetchMock);
    render(<PortalOffers preview={false} />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.queryByRole("status", { name: "Loading packages" })).not.toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Packages" })).not.toBeInTheDocument();
    expect(screen.queryByText(/front desk/i)).not.toBeInTheDocument();
  });

  it("says what went wrong and tries again when asked", async () => {
    const user = userEvent.setup();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++calls === 1
      ? ({ ok: false, status: 500, json: async () => ({ error: { code: "boom", message: "Your packages are down." } }) } as Response)
      : ({ ok: true, status: 200, json: async () => ({ data: { people: [person()] } }) } as Response))));
    render(<PortalOffers preview={false} />);
    expect(await screen.findByText("Your packages are down.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("7 of 10 left")).toBeInTheDocument();
  });

  it("shows a loading state first", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    render(<PortalOffers preview={false} />);
    expect(screen.getByRole("status", { name: "Loading packages" })).toBeInTheDocument();
  });

  it("shows nothing and sends nothing in the preview", () => {
    const fetchMock = answer([person()]);
    vi.stubGlobal("fetch", fetchMock);
    render(<PortalOffers preview />);
    expect(screen.queryByRole("region", { name: "Packages" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
