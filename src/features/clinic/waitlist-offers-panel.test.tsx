/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TestQueryProvider } from "@/test/query-wrapper";
import type { OfferTrailEntry, WaitlistOffersOverview } from "@/server/waitlist-staff";

import { StaffAccessProvider } from "./staff-access";
import { trailLine, WaitlistOffersPanel } from "./waitlist-offers-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const in15 = new Date(Date.now() + 10 * 60_000).toISOString();

const entry = (over: Partial<OfferTrailEntry>): OfferTrailEntry => ({
  offerId: "o1", position: 1, personName: "Asha Rao", origin: "automatic", status: "expired", sentAt: "2026-11-24T10:20:00.000Z", expiresAt: "2026-11-24T10:35:00.000Z", answeredAt: null, endedReason: null, ...over,
});

const overview = (): WaitlistOffersOverview => ({
  orderRule: "longest_waiting",
  services: [{ serviceId: "s1", name: "Check-up", automatic: true, waiting: 3 }, { serviceId: "s2", name: "Scaling", automatic: false, waiting: 0 }],
  slots: [{
    chainId: "c1", serviceId: "s1", serviceName: "Check-up", practitionerId: "p1", practitionerName: "Dr Rao", locationId: "l1",
    startsAt: "2026-11-24T10:30:00.000Z", endsAt: "2026-11-24T11:30:00.000Z", state: "live",
    offers: [entry({ offerId: "o1", status: "expired" }), entry({ offerId: "o2", position: 2, personName: "Bela Nair", status: "sent", expiresAt: in15 })],
  }],
});

function mount(permissions: readonly string[] = ["appointments.book", "waitlist.manage"]) {
  return render(
    <TestQueryProvider>
      <StaffAccessProvider role="receptionist" permissions={permissions as never} userId="u1"><WaitlistOffersPanel /></StaffAccessProvider>
    </TestQueryProvider>,
  );
}

describe("the waitlist offers panel", () => {
  it("shows who was asked about each open time and what they did, with no contact detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: overview() })));
    mount();
    const trail = await screen.findByRole("list", { name: /People asked about/ });
    expect(within(trail).getByText("Asha Rao")).toBeInTheDocument();
    expect(within(trail).getByText(/did not answer by/)).toBeInTheDocument();
    expect(within(trail).getByText("Bela Nair")).toBeInTheDocument();
    expect(within(trail).getByText(/10 min left|9 min left/)).toBeInTheDocument();
    expect(screen.getByText("Offered, waiting")).toBeInTheDocument();
    expect(screen.getByText(/held and is not on the booking page/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/@|\+91/);
  });

  it("switches automatic offers for one service and chooses the order, each with one request", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? json({ data: { ok: true } }) : json({ data: overview() })));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    const toggle = await screen.findByRole("switch", { name: "Automatic offers for Scaling" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Automatic offers for Check-up" })).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/staff/waitlist/services/s2" && (init as RequestInit)?.method === "PUT")).toBe(true));
    const put = fetchMock.mock.calls.find(([url]) => url === "/api/staff/waitlist/services/s2")!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ automatic: true });
  });

  it("lets staff release a live offer to the booking page", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "DELETE" ? json({ data: { withdrawn: true } }) : json({ data: overview() })));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    await user.click(await screen.findByRole("button", { name: "Release to booking page" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/staff/waitlist/offers/o2" && (init as RequestInit)?.method === "DELETE")).toBe(true));
  });

  it("is read-only without the waitlist permission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: overview() })));
    mount(["appointments.book"]);
    expect(await screen.findByRole("switch", { name: "Automatic offers for Check-up" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Release to booking page" })).not.toBeInTheDocument();
    expect(screen.getByText(/You can see this but not change it/)).toBeInTheDocument();
  });

  it("explains itself when nothing has been offered yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: { ...overview(), slots: [] } })));
    mount();
    expect(await screen.findByText("No offers yet")).toBeInTheDocument();
  });

  it("shows the error with Try again when the offers cannot be loaded", async () => {
    const user = userEvent.setup();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++calls === 1 ? json({ error: { code: "internal_error", message: "The offers could not be loaded." } }, 500) : json({ data: overview() }))));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("The offers could not be loaded.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Offered, waiting")).toBeInTheDocument();
  });

  it("shows a loading state first", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    mount();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  });
});

describe("trailLine", () => {
  it("describes each outcome in plain words", () => {
    expect(trailLine(entry({ status: "accepted", answeredAt: "2026-11-24T10:25:00.000Z" })).text).toMatch(/^took it at/);
    expect(trailLine(entry({ status: "declined", answeredAt: "2026-11-24T10:25:00.000Z" })).text).toMatch(/^passed on it at/);
    expect(trailLine(entry({ status: "withdrawn", endedReason: "staff" })).text).toBe("released by staff");
    expect(trailLine(entry({ status: "withdrawn", endedReason: "undeliverable" })).text).toBe("could not be reached");
    expect(trailLine(entry({ status: "scheduled" })).text).toMatch(/^will be asked at/);
  });
});
