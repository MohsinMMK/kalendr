/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoPractitioners, demoServices } from "@/lib/demo-data";
import type { ExplainResult } from "@/lib/availability-setup";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { StaffSnapshotProvider } from "./staff-snapshot-provider";

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
import { WhyNoSlotSheet } from "./why-no-slot-sheet";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const person = demoPractitioners[0]!;
const result: ExplainResult = {
  date: "2026-12-25", timezone: "Asia/Kolkata", durationMinutes: 30, steps: [], outOfOfficeNote: "Back on 3 January",
  bands: [
    { from: "00:00", to: "09:00", reason: "outside_hours", label: "Outside working hours" },
    { from: "09:00", to: "13:00", reason: "holiday", label: "Holiday: Christmas Day" },
    { from: "13:00", to: "15:00", reason: null, label: "" },
    { from: "15:00", to: "24:00", reason: "buffer_after", label: "Buffer after the 14:30 visit" },
  ],
};

function mount(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).startsWith("/api/staff/snapshot")) return new Response(JSON.stringify({ data: staffSnapshotFixture }), { status: 200 });
    return new Response(JSON.stringify({ data: result }), { status: 200 });
  });
  return render(<QueryClientProvider client={newClient()}><StaffSnapshotProvider role="owner"><WhyNoSlotSheet open onOpenChange={() => undefined} practitionerId={person.id} /></StaffSnapshotProvider></QueryClientProvider>);
}

describe("WhyNoSlotSheet", () => {
  it("asks for a service first, then shows each band with its reason and the note", async () => {
    const fetchMock = vi.fn();
    mount(fetchMock);
    expect(await screen.findByText("Choose who, what and when")).toBeInTheDocument();
    expect(screen.getByText("This only reads your settings. Nothing changes.")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("combobox"))[1]!);
    const service = demoServices.find((item) => item.practitionerIds.includes(person.id))!;
    await user.click(await screen.findByRole("option", { name: service.name }));

    expect(await screen.findByText("Holiday: Christmas Day")).toBeInTheDocument();
    expect(screen.getByText("Buffer after the 14:30 visit")).toBeInTheDocument();
    expect(screen.getAllByText("Offered").length).toBeGreaterThan(0);
    expect(screen.getByText("Out of office: Back on 3 January")).toBeInTheDocument();
    const call = fetchMock.mock.calls.map((entry) => String(entry[0])).find((url) => url.startsWith("/api/staff/availability/explain"))!;
    expect(call).toContain(`practitionerId=${person.id}`);
    expect(call).toContain(`serviceId=${service.id}`);
  });

  it("shows an error with a way to retry", async () => {
    const fetchMock = vi.fn();
    mount(fetchMock);
    let calls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith("/api/staff/snapshot")) return new Response(JSON.stringify({ data: staffSnapshotFixture }), { status: 200 });
      calls += 1;
      return calls === 1 ? new Response(JSON.stringify({ error: { message: "That did not work." } }), { status: 500 }) : new Response(JSON.stringify({ data: result }), { status: 200 });
    });
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("combobox"))[1]!);
    const service = demoServices.find((item) => item.practitionerIds.includes(person.id))!;
    await user.click(await screen.findByRole("option", { name: service.name }));
    expect(await screen.findByText("That did not work.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByText("Holiday: Christmas Day")).toBeInTheDocument());
  });
});
