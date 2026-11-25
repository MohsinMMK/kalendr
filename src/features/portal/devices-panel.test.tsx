/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevicesPanel } from "./devices-panel";

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.replace.mockClear();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const device = (over: Record<string, unknown> = {}) => ({ id: "d1", label: "Chrome on Mac", createdAt: "2026-11-01T10:00:00Z", expiresAt: "2026-12-01T10:00:00Z", remember: true, current: true, ...over });

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return handler(url, init);
  }));
  return calls;
}

describe("devices panel", () => {
  it("shows loading, then each device with its badge and how long it lasts", async () => {
    mockFetch(() => json({ data: { devices: [device(), device({ id: "d2", label: "Safari on iPhone", current: false, remember: false })] } }));
    render(<DevicesPanel />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading your devices");
    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("This device")).toBeInTheDocument();
    expect(within(items[0]).getByText(/Remembered for 30 days/)).toBeInTheDocument();
    expect(within(items[1]).getByText(/Signed out automatically after a day/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out everywhere else" })).toBeEnabled();
  });

  it("disables sign out everywhere else when only this device is listed", async () => {
    mockFetch(() => json({ data: { devices: [device()] } }));
    render(<DevicesPanel />);
    await screen.findByText("Chrome on Mac");
    expect(screen.getByRole("button", { name: "Sign out everywhere else" })).toBeDisabled();
  });

  it("shows an error with Try again, and an empty state", async () => {
    const user = userEvent.setup();
    let fail = true;
    mockFetch(() => (fail ? json({ error: { code: "x", message: "Nope." } }, 500) : json({ data: { devices: [] } })));
    render(<DevicesPanel />);
    expect(await screen.findByText("Nope.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No devices to show")).toBeInTheDocument();
  });

  it("signs out another device and announces it", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((url, init) => {
      if (init?.method === "DELETE") return json({ data: { signedOut: true } });
      return json({ data: { devices: [device(), device({ id: "d2", label: "Safari on iPhone", current: false })] } });
    });
    render(<DevicesPanel />);
    await user.click(await screen.findByRole("button", { name: "Actions for Safari on iPhone" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Signed out Safari on iPhone.");
    expect(calls).toContain("DELETE /api/portal/devices/d2");
    expect(screen.queryByText("Safari on iPhone", { selector: "span" })).not.toBeInTheDocument();
  });

  it("confirms before signing out this device, then goes to sign-in", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((url, init) => (init?.method === "DELETE" ? json({ data: { signedOut: true } }) : json({ data: { devices: [device()] } })));
    render(<DevicesPanel />);
    await user.click(await screen.findByRole("button", { name: "Actions for Chrome on Mac" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/portal/sign-in"));
  });

  it("signs out everywhere else and keeps only this device", async () => {
    const user = userEvent.setup();
    mockFetch((url) => {
      if (url === "/api/portal/auth/sign-out-others") return json({ data: { signedOut: 2 } });
      return json({ data: { devices: [device(), device({ id: "d2", current: false }), device({ id: "d3", current: false })] } });
    });
    render(<DevicesPanel />);
    await user.click(await screen.findByRole("button", { name: "Sign out everywhere else" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Signed out 2 other devices.");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("makes no requests in preview", async () => {
    const calls = mockFetch(() => json({}));
    render(<DevicesPanel preview />);
    expect(await screen.findByText("This device")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
