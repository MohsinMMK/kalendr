/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AcceptResult, OfferView } from "@/server/waitlist-accept";

import { minutesLeft, OfferPage } from "./offer-page";

vi.mock("next/image", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = (over: Partial<OfferView> = {}): OfferView => ({
  state: "open",
  startsAt: "2026-11-24T10:30:00.000Z",
  endsAt: "2026-11-24T11:30:00.000Z",
  timezone: "Asia/Kolkata",
  expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(),
  serviceName: "Check-up",
  practitionerName: "Dr Rao",
  locationName: "Main clinic",
  business: { name: "Lotus Dental", phone: "+91 98000 00000", slug: "lotus-dental" },
  laterAppointmentAt: null,
  ...over,
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

describe("the offer page", () => {
  it("shows the time, who it is with and how long is left, and takes it in one tap", async () => {
    const user = userEvent.setup();
    const taken: AcceptResult = { appointmentId: "a1", status: "booked", startsAt: view().startsAt, endsAt: view().endsAt, manageToken: "manage-token-abc", laterAppointmentAt: null };
    const fetchMock = vi.fn(async () => json({ data: taken }, 201));
    vi.stubGlobal("fetch", fetchMock);
    render(<OfferPage token="tok-offer-token-value-0000" initial={view()} />);

    expect(screen.getByRole("heading", { name: "A time just opened up" })).toBeInTheDocument();
    expect(screen.getByText(/4:00 pm/)).toBeInTheDocument();
    expect(screen.getByText("Check-up")).toBeInTheDocument();
    expect(screen.getByText("Dr Rao")).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent(/12 minutes left/);

    await user.click(screen.getByRole("button", { name: "Take this time" }));
    expect(await screen.findByRole("heading", { name: "You’re booked" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/public/offers/tok-offer-token-value-0000");
    expect(JSON.parse(String(init.body))).toEqual({ action: "accept" });
    expect(screen.getByRole("link", { name: /Manage/ })).toHaveAttribute("href", "/manage/manage-token-abc");
  });

  it("offers to cancel a later booking of the same service after taking the earlier time", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const action = (JSON.parse(String(init?.body)) as { action: string }).action;
      if (action === "accept") return json({ data: { appointmentId: "a1", status: "booked", startsAt: view().startsAt, endsAt: view().endsAt, manageToken: "mt-123456789", laterAppointmentAt: "2026-12-02T10:30:00.000Z" } }, 201);
      return json({ data: { cancelled: true } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OfferPage token="tok-offer-token-value-0000" initial={view()} />);
    await user.click(screen.getByRole("button", { name: "Take this time" }));
    expect(await screen.findByRole("heading", { name: /Cancel your later/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel the later one" }));
    expect(await screen.findByText(/later appointment is cancelled/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ action: "cancel_later" });
  });

  it("lets the person pass on it and says they stay on the waitlist", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: { state: "declined" } })));
    render(<OfferPage token="tok-offer-token-value-0000" initial={view()} />);
    await user.click(screen.getByRole("button", { name: "Not this time" }));
    expect(await screen.findByRole("heading", { name: "Thanks for letting us know" })).toBeInTheDocument();
    expect(screen.getByText(/stay on the waitlist/)).toBeInTheDocument();
  });

  it("says the time is gone, with a way to look for another, when the offer ran out or was taken", async () => {
    render(<OfferPage token="tok-offer-token-value-0000" initial={view({ state: "closed" })} />);
    expect(screen.getByRole("heading", { name: "This time is no longer open" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See other times" })).toHaveAttribute("href", "/book/lotus-dental");
    expect(screen.queryByRole("button", { name: "Take this time" })).not.toBeInTheDocument();
  });

  it("closes the offer on screen when the server says another person has it", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "offer_closed", message: "This time is no longer available." } }, 410)));
    render(<OfferPage token="tok-offer-token-value-0000" initial={view()} />);
    await user.click(screen.getByRole("button", { name: "Take this time" }));
    expect(await screen.findByRole("heading", { name: "This time is no longer open" })).toBeInTheDocument();
  });

  it("shows a readable error and keeps the buttons when the network fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "internal_error", message: "The request could not be completed." } }, 500)));
    render(<OfferPage token="tok-offer-token-value-0000" initial={view()} />);
    await user.click(screen.getByRole("button", { name: "Take this time" }));
    expect(await screen.findByText("The request could not be completed.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Take this time" })).toBeEnabled());
  });

  it("offers Try again when the page could not load the offer at all", () => {
    render(<OfferPage token="tok-offer-token-value-0000" initial={null} />);
    expect(screen.getByRole("heading", { name: "We could not load this time" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("treats a time whose answer period ended while the page was open as closed", () => {
    render(<OfferPage token="tok-offer-token-value-0000" initial={view({ expiresAt: new Date(Date.now() - 1_000).toISOString() })} />);
    expect(screen.getByRole("heading", { name: "This time is no longer open" })).toBeInTheDocument();
  });

  it("counts whole minutes left and never goes below zero", () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    expect(minutesLeft("2026-11-20T10:12:01Z", now)).toBe(13);
    expect(minutesLeft("2026-11-20T09:59:00Z", now)).toBe(0);
  });
});
