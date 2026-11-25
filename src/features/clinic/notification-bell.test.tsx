/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { ago, NotificationBell } from "./notification-bell";
import { createStaffQueryClient } from "./queries/client";

const item = (overrides: Record<string, unknown> = {}) => ({
  id: "n1", kind: "new_booking", title: "New booking at 4:30 pm", link: "/schedule?open=abc", read: false, at: new Date().toISOString(), ...overrides,
});

function respond(list: unknown, status = 200) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/read") && init?.method === "POST") {
      return Response.json({ data: { items: [item({ read: true })], unread: 0 } });
    }
    return status === 200 ? Response.json({ data: list }) : Response.json({ error: { code: "x", message: "no" } }, { status });
  });
}

function renderBell() {
  render(<QueryClientProvider client={createStaffQueryClient()}><NotificationBell /></QueryClientProvider>);
}

const bellButton = (name: RegExp) => screen.findByRole("button", { name });

beforeEach(() => { push.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("notifications bell", () => {
  it("shows unread alerts and what needs attention in one badge", async () => {
    vi.stubGlobal("fetch", respond({ items: [item(), item({ id: "n2" })], unread: 2 }));
    renderBell();
    const bell = await bellButton(/^Notifications: 2 unread, \d+ need attention$/);
    const needs = Number(/(\d+) need attention/.exec(bell.getAttribute("aria-label") ?? "")?.[1]);
    expect(needs).toBeGreaterThan(0);
    expect(bell.querySelector("[data-count]")).toHaveAttribute("data-count", String(2 + needs));
  });

  it("has an Alerts tab and a Needs attention tab, each with its count, and a link to the settings", async () => {
    vi.stubGlobal("fetch", respond({ items: [item()], unread: 1 }));
    const user = userEvent.setup();
    renderBell();
    await user.click(await bellButton(/^Notifications/));
    const drawer = await screen.findByRole("dialog", { name: "Notifications" });
    expect(within(drawer).getByRole("link", { name: "Notification settings" })).toHaveAttribute("href", "/profile/notifications");
    // With something unread, it opens on Alerts.
    expect(within(drawer).getByRole("tab", { name: /^Alerts1$/ })).toHaveAttribute("aria-selected", "true");
    expect(within(drawer).getByRole("tab", { name: /^Needs attention\d+$/ })).toBeInTheDocument();
    await user.click(within(drawer).getByRole("tab", { name: /^Needs attention/ }));
    expect(await within(drawer).findByRole("region", { name: "Needs attention" })).toBeInTheDocument();
  });

  it("opens on Needs attention when no alert is unread", async () => {
    vi.stubGlobal("fetch", respond({ items: [item({ read: true })], unread: 0 }));
    const user = userEvent.setup();
    renderBell();
    await user.click(await bellButton(/^Notifications: \d+ need attention$/));
    const drawer = await screen.findByRole("dialog", { name: "Notifications" });
    expect(within(drawer).getByRole("tab", { name: /^Needs attention/ })).toHaveAttribute("aria-selected", "true");
  });

  it("opens an alert: marks it read and goes to the appointment", async () => {
    const fetchMock = respond({ items: [item()], unread: 1 });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderBell();
    await user.click(await bellButton(/^Notifications/));
    await user.click(await screen.findByRole("button", { name: /New booking at 4:30 pm/ }));
    expect(push).toHaveBeenCalledWith("/schedule?open=abc");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/staff/notifications/read", expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: ["n1"] }) })));
  });

  it("marks everything read from the Alerts tab", async () => {
    const fetchMock = respond({ items: [item()], unread: 1 });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderBell();
    await user.click(await bellButton(/^Notifications/));
    await user.click(await screen.findByRole("button", { name: /Mark all read/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/staff/notifications/read", expect.objectContaining({ body: JSON.stringify({ all: true }) })));
  });

  it("never follows a link that leaves the app", async () => {
    vi.stubGlobal("fetch", respond({ items: [item({ link: "https://evil.example" })], unread: 1 }));
    const user = userEvent.setup();
    renderBell();
    await user.click(await bellButton(/^Notifications/));
    await user.click(await screen.findByRole("button", { name: /New booking/ }));
    expect(push).not.toHaveBeenCalled();
  });

  it("says plainly when there is nothing yet", async () => {
    vi.stubGlobal("fetch", respond({ items: [], unread: 0 }));
    const user = userEvent.setup();
    renderBell();
    await user.click(await bellButton(/^Notifications/));
    await user.click(await screen.findByRole("tab", { name: /^Alerts/ }));
    expect(await screen.findByText("No alerts yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mark all read/ })).toBeDisabled();
  });

  it("says so when alerts cannot be loaded, and lets you try again", async () => {
    vi.stubGlobal("fetch", respond(null, 500));
    const user = userEvent.setup();
    renderBell();
    await user.click(await bellButton(/^Notifications/));
    await user.click(await screen.findByRole("tab", { name: /^Alerts/ }));
    expect(await screen.findByText("Alerts could not be loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("writes times a person would say", () => {
    const now = new Date("2026-11-19T10:00:00Z").getTime();
    expect(ago("2026-11-19T09:59:50Z", now)).toBe("just now");
    expect(ago("2026-11-19T09:55:00Z", now)).toBe("5 min ago");
    expect(ago("2026-11-19T07:00:00Z", now)).toBe("3 h ago");
  });
});
