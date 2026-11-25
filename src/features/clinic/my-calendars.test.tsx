/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import { TestQueryProvider } from "@/test/query-wrapper";
import type { CalendarOverview } from "@/lib/calendar-sync";

import { MyCalendars } from "./my-calendars";

const calendar = (overrides: Record<string, unknown> = {}) => ({
  id: "cal1", name: "Work", primary: true, canWrite: true, blocksAvailability: false, writesHere: false, lastSyncedAt: null, version: 1, ...overrides,
});
const connection = (overrides: Record<string, unknown> = {}) => ({
  id: "con1", provider: "google", accountEmail: "me@example.com", status: "active", lastErrorCode: null, ownerName: "Asha", mine: true, calendars: [calendar()], ...overrides,
});
const overview = (overrides: Partial<Record<keyof CalendarOverview, unknown>> = {}) => ({
  mode: "live",
  providers: [
    { provider: "google", available: true, reason: null },
    { provider: "microsoft", available: false, reason: "Ask your administrator to add the Outlook keys." },
    { provider: "apple", available: true, reason: null },
  ],
  maxConnections: 3,
  connections: [],
  conflicts: [],
  eventText: "full",
  canManageSettings: false,
  feed: { active: false, createdAt: null },
  ...overrides,
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function show(preview = false) {
  render(<ToastProvider><TestQueryProvider><MyCalendars preview={preview} /></TestQueryProvider></ToastProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("My calendars", () => {
  it("shows a loading state first", () => {
    stubFetch(() => new Promise<Response>(() => {}));
    show();
    expect(screen.getByRole("status", { name: "Loading your calendars" })).toBeInTheDocument();
  });

  it("says what to do when nothing is connected, and offers each provider honestly", async () => {
    stubFetch(() => Response.json({ data: overview() }));
    show();
    expect(await screen.findByText(/No calendar is connected yet/)).toBeInTheDocument();
    expect(screen.getByText("Ask your administrator to add the Outlook keys.")).toBeInTheDocument();
    const outlook = screen.getByText("Outlook").closest("li")!;
    expect(within(outlook).getByRole("button", { name: "Connect" })).toBeDisabled();
    const google = screen.getByText("Google Calendar").closest("li")!;
    expect(within(google).getByRole("link", { name: "Connect" })).toHaveAttribute("href", "/api/staff/calendars/connect/google");
  });

  it("says so when it cannot load, and tries again", async () => {
    let calls = 0;
    const mock = stubFetch(() => (++calls === 1 ? Response.json({ error: { code: "x", message: "no" } }, { status: 500 }) : Response.json({ data: overview() })));
    const user = userEvent.setup();
    show();
    expect(await screen.findByText("Your calendars could not be loaded.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/No calendar is connected yet/)).toBeInTheDocument();
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("marks a connection that needs reconnecting with words, and offers the sign-in link", async () => {
    stubFetch(() => Response.json({ data: overview({ connections: [connection({ status: "needs_reconnect", calendars: [] })] }) }));
    show();
    expect(await screen.findByText("Needs reconnecting")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/api/staff/calendars/connect/google");
  });

  it("asks before disconnecting, then disconnects", async () => {
    const mock = stubFetch((url, init) => (init?.method === "DELETE" ? Response.json({ data: overview() }) : Response.json({ data: overview({ connections: [connection()] }) })));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Your calendar stays as it is. Kalendr stops reading it and forgets the busy times it saved.")).toBeInTheDocument();
    expect(mock).not.toHaveBeenCalledWith(expect.stringContaining("/connections/"), expect.anything());
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/api/staff/calendars/connections/con1", expect.objectContaining({ method: "DELETE" })));
    expect(await screen.findByText(/No calendar is connected yet/)).toBeInTheDocument();
  });

  it("ticks a calendar to block availability", async () => {
    const mock = stubFetch((url, init) => (init?.method === "PATCH"
      ? Response.json({ data: overview({ connections: [connection({ calendars: [calendar({ blocksAvailability: true, version: 2 })] })] }) })
      : Response.json({ data: overview({ connections: [connection()] }) })));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("switch", { name: /Work/ }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/api/staff/calendars/selections/cal1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ blocksAvailability: true, version: 1 }) })));
    await waitFor(() => expect(screen.getByRole("switch", { name: /Work/ })).toBeChecked());
  });

  it("checks the Apple form before sending anything", async () => {
    const mock = stubFetch(() => Response.json({ data: overview() }));
    const user = userEvent.setup();
    show();
    const apple = (await screen.findByText("Apple Calendar")).closest("li")!;
    await user.click(within(apple).getByRole("button", { name: "Connect" }));
    await user.type(await screen.findByLabelText("Apple ID email"), "me@icloud.com");
    await user.type(screen.getByLabelText("App-specific password"), "not-it");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("An app-specific password looks like abcd-efgh-ijkl-mnop.")).toBeInTheDocument();
    expect(mock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("lets only an owner or admin change the event text", async () => {
    stubFetch(() => Response.json({ data: overview({ eventText: "busy_only" }) }));
    show();
    expect(await screen.findByText("Just “Busy”")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "What your calendar shows" })).not.toBeInTheDocument();
    cleanup();
    stubFetch(() => Response.json({ data: overview({ canManageSettings: true }) }));
    show();
    expect(await screen.findByRole("combobox", { name: "What your calendar shows" })).toBeInTheDocument();
  });

  it("offers two ways to settle a moved event, and warns the customer will be told", async () => {
    const mock = stubFetch((url, init) => (init?.method === "POST" ? Response.json({ data: overview() }) : Response.json({ data: overview({
      conflicts: [{ id: "k1", appointmentId: "a1", kind: "moved", appointmentStartsAt: "2026-11-20T04:30:00Z", appointmentEndsAt: "2026-11-20T05:00:00Z", eventStartsAt: "2026-11-20T06:30:00Z", eventEndsAt: "2026-11-20T07:00:00Z", ownerName: "Asha", createdAt: "2026-11-19T10:00:00Z" }],
    }) })));
    const user = userEvent.setup();
    show();
    expect(await screen.findByRole("button", { name: /Put the calendar event back/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /to match/ }));
    expect(await screen.findByText(/is told about the new time/)).toBeInTheDocument();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /Move the/ }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/api/staff/calendars/conflicts/k1", expect.objectContaining({ body: JSON.stringify({ action: "move_appointment" }) })));
  });

  it("is labelled unavailable in the preview and makes no request", () => {
    const mock = stubFetch(() => Response.json({ data: overview() }));
    show(true);
    expect(screen.getByText(/Calendar sync is not available in the preview/)).toBeInTheDocument();
    expect(mock).not.toHaveBeenCalled();
  });

  it("marks test accounts so nobody thinks they are real", async () => {
    stubFetch(() => Response.json({ data: overview({ mode: "fake" }) }));
    show();
    expect(await screen.findByText("Test accounts")).toBeInTheDocument();
  });

  it("keeps checking every 3 seconds while a connection is pending", async () => {
    const mock = stubFetch(() => Response.json({ data: overview({ connections: [connection({ status: "pending", calendars: [] })] }) }));
    show();
    expect(await screen.findByText("Checking…")).toBeInTheDocument();
    expect(mock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mock.mock.calls.length).toBeGreaterThan(1), { timeout: 4500 });
  }, 8000);
});
