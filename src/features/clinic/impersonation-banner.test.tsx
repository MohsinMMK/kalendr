/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatCountdown, ImpersonationBanner } from "./impersonation-banner";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const start = new Date("2026-11-19T10:00:00.000Z");
const facts = (over: Record<string, unknown> = {}) => ({ sessionId: "s1", endsAt: new Date(start.getTime() + (27 * 60 + 41) * 1000).toISOString(), writeAccess: false, businessName: "City Clinic", ...over });

beforeEach(() => { vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] }); vi.setSystemTime(start); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); push.mockClear(); });

describe("formatCountdown", () => {
  it("pads seconds and never goes negative", () => {
    expect(formatCountdown(1661)).toBe("27:41");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(-4)).toBe("0:00");
  });
});

describe("ImpersonationBanner", () => {
  it("names the business, says read-only and counts down every second", () => {
    render(<ImpersonationBanner impersonation={facts()} />);
    expect(screen.getByText(/Viewing City Clinic as Kalendr support\. Read-only\./)).toBeInTheDocument();
    expect(screen.getByText("27:41")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("27:40")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("26:40")).toBeInTheDocument();
  });

  it("is a polite status region and does not read the ticking time aloud", () => {
    render(<ImpersonationBanner impersonation={facts()} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("27:41").closest("[aria-hidden=true]")).not.toBeNull();
  });

  it("says when changes are allowed", () => {
    render(<ImpersonationBanner impersonation={facts({ writeAccess: true })} />);
    expect(screen.getByText(/Changes are allowed and logged\./)).toBeInTheDocument();
    expect(screen.queryByText(/Read-only/)).not.toBeInTheDocument();
  });

  it("announces the minutes left only in the last five", () => {
    render(<ImpersonationBanner impersonation={facts({ endsAt: new Date(start.getTime() + 4 * 60_000 + 10_000).toISOString() })} />);
    expect(screen.getByText("Ends in 5 minutes.")).toBeInTheDocument();
  });

  it("reloads into the normal state when the time runs out, once", () => {
    const expire = vi.fn();
    render(<ImpersonationBanner impersonation={facts({ endsAt: new Date(start.getTime() + 3000).toISOString() })} onExpire={expire} />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(expire).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(expire).toHaveBeenCalledTimes(1);
    expect(screen.getByText("0:00")).toBeInTheDocument();
  });

  it("End session posts to the API and then leaves for the console", async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { ended: true } }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const ended = vi.fn();
    render(<ImpersonationBanner impersonation={facts({ endsAt: new Date(Date.now() + 600_000).toISOString() })} onEnded={ended} />);
    await userEvent.click(screen.getByRole("button", { name: "End session" }));
    await waitFor(() => expect(ended).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/impersonation/end", expect.objectContaining({ method: "POST" }));
  });

  it("shows a refusal and lets the person try again", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: { code: "internal", message: "Could not end it." } }) }) as Response));
    render(<ImpersonationBanner impersonation={facts({ endsAt: new Date(Date.now() + 600_000).toISOString() })} />);
    await userEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(await screen.findByText("Could not end it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End session" })).toBeEnabled();
  });
});
