/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Schedule } from "@/lib/availability-setup";

import { PersonSchedules } from "./person-schedules";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const emptyWeek = { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] } as Schedule["weekly"];
function schedule(version = 1, monday = [{ start: "09:00", end: "13:00" }]): Schedule {
  return { id: "s1", practitionerId: "p1", name: "Working hours", timezone: "Asia/Kolkata", isDefault: true, version, weekly: { ...emptyWeek, "1": monday }, overrides: [] };
}

function mount(patch?: () => Response, list: () => Response = () => new Response(JSON.stringify({ data: [schedule()] }))) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    requests.push({ url, method, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (method === "PATCH") return patch?.() ?? new Response(JSON.stringify({ data: schedule(2) }));
    return list();
  }));
  render(<PersonSchedules practitionerId="p1" name="Dr Rao" title="Dentist" />);
  return requests;
}

describe("person schedules", () => {
  it("shows the schedule and its ranges once loaded", async () => {
    mount();
    expect(await screen.findByRole("group", { name: "Monday hours" })).toBeInTheDocument();
    expect(screen.getAllByText("Closed").length).toBe(6);
  });

  it("adds a second range to Monday, which shows as its own row", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Add a range on Monday" }));
    expect(screen.getByRole("group", { name: "Monday range 2" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Monday range 1" })).toBeInTheDocument();
  });

  it("saves with the version it loaded", async () => {
    const requests = mount();
    await userEvent.click(await screen.findByRole("button", { name: "Add a range on Tuesday" }));
    await userEvent.click(screen.getByRole("button", { name: "Save hours" }));
    await waitFor(() => expect(requests.some((entry) => entry.method === "PATCH")).toBe(true));
    const patch = requests.find((entry) => entry.method === "PATCH");
    expect(patch?.body).toMatchObject({ expectedVersion: 1, timezone: "Asia/Kolkata" });
  });

  it("says someone else changed it when the save is refused as stale", async () => {
    mount(() => new Response(JSON.stringify({ error: { code: "version_conflict", message: "Changed." } }), { status: 409 }));
    await userEvent.click(await screen.findByRole("button", { name: "Add a range on Tuesday" }));
    await userEvent.click(screen.getByRole("button", { name: "Save hours" }));
    expect(await screen.findByText(/Someone else changed this/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reload/ })).toBeInTheDocument();
  });

  it("offers a retry when the schedules cannot be loaded", async () => {
    mount(undefined, () => new Response(JSON.stringify({ error: { code: "x", message: "Down." } }), { status: 500 }));
    expect(await screen.findByText("Down.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
