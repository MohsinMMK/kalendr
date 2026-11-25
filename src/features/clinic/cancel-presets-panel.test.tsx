/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staffSnapshotFixture } from "@/test/staff-fixture";

import { CancelPresetsPanel } from "./cancel-presets-panel";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Preset = { id: string; label: string; sortOrder: number };
interface Call { url: string; method: string; body?: unknown }

function setup(initial: Preset[], handlers: { post?: (body: { label: string }) => Response; get?: () => Response } = {}) {
  let presets = [...initial];
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (url === "/api/staff/snapshot") return new Response(JSON.stringify({ data: staffSnapshotFixture }));
    calls.push({ url, method, body });
    if (url === "/api/staff/cancel-presets" && method === "GET") return handlers.get?.() ?? new Response(JSON.stringify({ data: presets }));
    if (url === "/api/staff/cancel-presets" && method === "POST") {
      const custom = handlers.post?.(body);
      if (custom) return custom;
      const preset = { id: `p${presets.length + 1}`, label: body.label, sortOrder: presets.length };
      presets = [...presets, preset];
      return new Response(JSON.stringify({ data: preset }), { status: 201 });
    }
    if (method === "DELETE") { presets = presets.filter((preset) => url.endsWith(`/${preset.id}`) === false); return new Response(JSON.stringify({ data: { ok: true } })); }
    return new Response("{}", { status: 404 });
  }));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StaffSnapshotProvider role="owner"><CancelPresetsPanel /></StaffSnapshotProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe("the cancellation reasons panel", () => {
  it("lists the reasons", async () => {
    setup([{ id: "p1", label: "Power cut", sortOrder: 0 }, { id: "p2", label: "Road closed", sortOrder: 1 }]);
    expect(await screen.findByText("Power cut")).toBeInTheDocument();
    expect(screen.getByText("Road closed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Power cut" })).toBeInTheDocument();
  });

  it("adds a reason with the label in the body", async () => {
    const calls = setup([{ id: "p1", label: "Power cut", sortOrder: 0 }]);
    const user = userEvent.setup();
    await screen.findByText("Power cut");
    await user.type(screen.getByLabelText("New cancellation reason"), "Road closed");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Road closed")).toBeInTheDocument();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ label: "Road closed" });
  });

  it("shows a duplicate reason beside the field", async () => {
    setup([{ id: "p1", label: "Power cut", sortOrder: 0 }], {
      post: () => new Response(JSON.stringify({ error: { code: "preset_exists", message: "That reason is already there.", fieldErrors: { label: ["That reason is already there."] } } }), { status: 409 }),
    });
    const user = userEvent.setup();
    await screen.findByText("Power cut");
    await user.type(screen.getByLabelText("New cancellation reason"), "power cut");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("That reason is already there.")).toBeInTheDocument();
  });

  it("removes a reason", async () => {
    const calls = setup([{ id: "p1", label: "Power cut", sortOrder: 0 }, { id: "p2", label: "Road closed", sortOrder: 1 }]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove Power cut" }));
    await waitFor(() => expect(screen.queryByText("Power cut")).not.toBeInTheDocument());
    expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/staff/cancel-presets/p1")).toBe(true);
  });

  it("offers suggested reasons when the list is empty and adds them", async () => {
    const calls = setup([]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add suggested reasons" }));
    expect(await screen.findByText("Closed that day")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST").map((call) => (call.body as { label: string }).label)).toEqual(["Doctor unwell", "Staff unwell", "Closed that day"]);
  });

  it("offers a retry when the reasons cannot be loaded", async () => {
    let attempts = 0;
    setup([{ id: "p1", label: "Power cut", sortOrder: 0 }], { get: () => (++attempts === 1 ? new Response(JSON.stringify({ error: { code: "x", message: "Nope." } }), { status: 500 }) : new Response(JSON.stringify({ data: [{ id: "p1", label: "Power cut", sortOrder: 0 }] }))) });
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Power cut")).toBeInTheDocument();
  });
});
