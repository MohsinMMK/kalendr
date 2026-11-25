/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staffSnapshotFixture } from "@/test/staff-fixture";

import { BusinessProfileSettings } from "./business-profile-settings";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(options: { failLoad?: boolean } = {}) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/staff/snapshot") return new Response(JSON.stringify({ data: staffSnapshotFixture }));
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/staff/business-profile" && method === "GET") {
      if (options.failLoad) return new Response(JSON.stringify({ error: { code: "error", message: "No." } }), { status: 500 });
      return new Response(JSON.stringify({ data: { defaultClock: "24h", weekStart: 7 } }));
    }
    return new Response(JSON.stringify({ data: {} }));
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StaffSnapshotProvider role="owner"><BusinessProfileSettings /></StaffSnapshotProvider>
    </QueryClientProvider>,
  );
  return requests;
}

describe("booking page clock and week start", () => {
  it("shows the saved choices and saves a change with the business profile", async () => {
    const requests = setup();
    const user = userEvent.setup();
    const clock = await screen.findByRole("combobox", { name: "Clock on the booking page" });
    await waitFor(() => expect(clock).toHaveTextContent("24-hour"));
    expect(screen.getByRole("combobox", { name: "Week starts on" })).toHaveTextContent("Sunday");
    await user.click(clock);
    await user.click(await screen.findByRole("option", { name: "12-hour" }));
    await user.click(screen.getByRole("button", { name: "Save business profile" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    expect(requests.find((request) => request.method === "PATCH")?.body).toMatchObject({ defaultClock: "12h", weekStart: 7 });
  });

  it("leaves the saved choices alone when they could not be loaded", async () => {
    const requests = setup({ failLoad: true });
    const user = userEvent.setup();
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Clock on the booking page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save business profile" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const body = requests.find((request) => request.method === "PATCH")?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("defaultClock");
    expect(body).not.toHaveProperty("weekStart");
  });
});

describe("role names", () => {
  it("renames a role beside the words and saves it with the profile, leaving the standard name as the hint", async () => {
    const requests = setup();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Receptionist");
    expect(field).toHaveAttribute("placeholder", "Receptionist");
    await user.type(field, "Front desk");
    await user.click(screen.getByRole("button", { name: "Save business profile" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    expect(requests.find((request) => request.method === "PATCH")?.body).toMatchObject({ roleNames: { receptionist: "Front desk" } });
  });

  it("puts the standard name back with the reset button, and saves no role names", async () => {
    const requests = setup();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Receptionist");
    await user.type(field, "Front desk");
    await user.click(screen.getByRole("button", { name: "Use the standard name for receptionist" }));
    expect(field).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save business profile" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    expect(requests.find((request) => request.method === "PATCH")?.body).toMatchObject({ roleNames: {} });
  });

  it("describes every role, so each name has its job beside it", async () => {
    setup();
    for (const role of ["Owner", "Admin", "Receptionist", "Billing", "Read only"]) expect(await screen.findByLabelText(role, { exact: true })).toBeInTheDocument();
  });
});
