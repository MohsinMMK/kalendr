/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MySeatView } from "@/server/classes";

import { ClassSeatPage } from "./class-seat-page";

vi.mock("next/image", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const future = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

const seat = (over: Partial<MySeatView> = {}): MySeatView => ({
  enrolmentId: "e1", status: "booked", sessionStatus: "scheduled", serviceName: "Morning yoga", teacherName: "Asha Rao",
  startsAt: future(48), endsAt: future(49), timezone: "Asia/Kolkata", businessName: "Lotus Studio", position: null, offerExpiresAt: null, ...over,
});

describe("a customer's class link", () => {
  it("shows the class, teacher and time, and cancels only after a confirm step", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => json({ data: seat({ status: "cancelled" }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ClassSeatPage token="tok-seat-0000" initial={seat()} />);
    expect(screen.getByRole("heading", { level: 1, name: "You have a seat" })).toBeInTheDocument();
    expect(screen.getByText("Morning yoga")).toBeInTheDocument();
    expect(screen.getByText("Asha Rao")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel my place" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Cancel your place?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, cancel my place" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Your place is cancelled" })).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/public/class-seats/tok-seat-0000");
    expect(JSON.parse(String(init.body))).toEqual({ action: "cancel" });
  });

  it("lets someone change their mind at the confirm step", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ClassSeatPage token="tok-seat-0000" initial={seat()} />);
    await user.click(screen.getByRole("button", { name: "Cancel my place" }));
    await user.click(screen.getByRole("button", { name: "Keep my place" }));
    expect(screen.getByRole("button", { name: "Cancel my place" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the place in line when waiting without an offer", () => {
    render(<ClassSeatPage token="t" initial={seat({ status: "waitlisted", position: 3 })} />);
    expect(screen.getByRole("heading", { level: 1, name: "You’re number 3 on the waiting list" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave the waiting list" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take this seat" })).toBeNull();
  });

  it("counts down a held seat and takes it in one tap", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchMock = vi.fn(async () => json({ data: seat({ status: "booked" }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ClassSeatPage token="tok-seat-0000" initial={seat({ status: "waitlisted", position: 1, offerExpiresAt: new Date(Date.now() + 90_000).toISOString() })} />);
    expect(screen.getByRole("heading", { level: 1, name: "A seat opened up" })).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("1:30");
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole("timer")).toHaveTextContent(/1:2\d/);
    await user.click(screen.getByRole("button", { name: "Take this seat" }));
    expect(await screen.findByRole("heading", { level: 1, name: "You have a seat" })).toBeInTheDocument();
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ action: "accept_offer" });
  });

  it("tells the person plainly when the held seat has lapsed", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "offer_over", message: "This seat is no longer being held for you." } }, 409))
      .mockResolvedValueOnce(json({ data: seat({ status: "waitlisted", position: 2, offerExpiresAt: null }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ClassSeatPage token="tok-seat-0000" initial={seat({ status: "waitlisted", position: 1, offerExpiresAt: new Date(Date.now() + 60_000).toISOString() })} />);
    await user.click(screen.getByRole("button", { name: "Take this seat" }));
    expect(await screen.findByText("This seat is no longer being held for you.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take this seat" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "You’re number 2 on the waiting list" })).toBeInTheDocument();
  });

  it("says when the class was cancelled or the link could not load", () => {
    const { unmount } = render(<ClassSeatPage token="t" initial={seat({ sessionStatus: "cancelled" })} />);
    expect(screen.getByRole("heading", { level: 1, name: "This class was cancelled" })).toBeInTheDocument();
    unmount();
    render(<ClassSeatPage token="t" initial={null} />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
