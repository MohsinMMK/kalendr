/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staffSnapshotFixture } from "@/test/staff-fixture";

const navigation = vi.hoisted(() => ({ push: vi.fn(), pathname: "/dashboard" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: navigation.push, replace: vi.fn(), refresh: vi.fn() }), usePathname: () => navigation.pathname }));

import { ProductTour, requestProductTour } from "./product-tour";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

interface Call { url: string; method: string; body?: unknown }

function mount(tour: "new" | "done" | "skipped") {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/staff/snapshot") return new Response(JSON.stringify({ data: staffSnapshotFixture }));
    calls.push({ url, method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (url === "/api/staff/onboarding") return new Response(JSON.stringify({ data: { tour, steps: [], summary: {}, goLive: { checks: [], clear: true }, owner: {}, bookingUrl: "", sampleData: false, testRows: 0 } }));
    return new Response(JSON.stringify({ data: {} }));
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StaffSnapshotProvider role="owner"><ProductTour /></StaffSnapshotProvider>
    </QueryClientProvider>,
  );
  return calls;
}

beforeEach(() => {
  navigation.push.mockClear();
  navigation.pathname = "/dashboard";
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/dashboard");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the product tour", () => {
  it("starts on the owner's first visit to the dashboard, remembers the stop across page changes, and shows five stops", async () => {
    mount("new");
    // The first stop is on the schedule page, so the tour takes the owner there and remembers the stop across the page change.
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/schedule"));
    expect(window.sessionStorage.getItem("kalendr-tour-stop")).toBe("0");
    cleanup();
    // On the schedule page the stop shows.
    navigation.pathname = "/schedule";
    mount("new");
    expect(await screen.findByText("Stop 1 of 5")).toBeVisible();
    expect(screen.getByText("Your schedule")).toBeVisible();
  });

  it("does not start for an owner who has seen it or closed it, nor away from the dashboard", async () => {
    mount("done");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByText(/Stop \d of 5/)).not.toBeInTheDocument();
    cleanup();
    mount("skipped");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByText(/Stop \d of 5/)).not.toBeInTheDocument();
    cleanup();
    navigation.pathname = "/bookings";
    mount("new");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByText(/Stop \d of 5/)).not.toBeInTheDocument();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("can be closed at any point, which records it as seen, and opened again from Help", async () => {
    navigation.pathname = "/schedule";
    window.sessionStorage.setItem("kalendr-tour-stop", "0");
    const calls = mount("new");
    const user = userEvent.setup();
    expect(await screen.findByText("Stop 1 of 5")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close tour" }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/staff/onboarding/tour")?.body).toEqual({ action: "skip" }));
    expect(screen.queryByText("Stop 1 of 5")).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem("kalendr-tour-stop")).toBeNull();
    act(() => requestProductTour());
    expect(await screen.findByText("Stop 1 of 5")).toBeVisible();
  });

  it("the last stop says Finish and records the tour as done", async () => {
    navigation.pathname = "/dashboard";
    window.sessionStorage.setItem("kalendr-tour-stop", "4");
    const calls = mount("new");
    const user = userEvent.setup();
    expect(await screen.findByText("Stop 5 of 5")).toBeVisible();
    expect(screen.getByRole("button", { name: "Back" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/staff/onboarding/tour")?.body).toEqual({ action: "done" }));
  });

  it("closes on Escape", async () => {
    navigation.pathname = "/patients";
    window.sessionStorage.setItem("kalendr-tour-stop", "2");
    const calls = mount("new");
    expect(await screen.findByText("Stop 3 of 5")).toBeVisible();
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(calls.find((call) => call.url === "/api/staff/onboarding/tour")?.body).toEqual({ action: "skip" }));
    expect(screen.queryByText("Stop 3 of 5")).not.toBeInTheDocument();
  });
});
