/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoResources } from "@/lib/demo-data";
import { TestQueryProvider } from "@/test/query-wrapper";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { ResourcesSettings, resourceUpdateBody } from "./resources-settings";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("resourceUpdateBody", () => {
  it("trims the name and sends only what changed", () => {
    expect(resourceUpdateBody({ name: " Chair 2 " })).toEqual({ name: "Chair 2" });
    expect(resourceUpdateBody({ isActive: false })).toEqual({ isActive: false });
  });
});

describe("rooms and chairs settings", () => {
  function setup() {
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/staff/snapshot") return new Response(JSON.stringify({ data: staffSnapshotFixture }));
      requests.push({ url, method: options?.method, body: options?.body ? JSON.parse(String(options.body)) : undefined });
      return new Response(JSON.stringify({ data: {} }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <TestQueryProvider><StaffSnapshotProvider role="owner">
        <ResourcesSettings />
      </StaffSnapshotProvider></TestQueryProvider>,
    );
    return requests;
  }

  it("renames a room in place", async () => {
    const requests = setup();
    const first = demoResources[0]!;
    const user = userEvent.setup();
    const input = await screen.findByRole("textbox", { name: `Name of ${first.name}` });
    expect(screen.queryByRole("button", { name: `Save name for ${first.name}` })).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "Quiet room");
    await user.click(screen.getByRole("button", { name: `Save name for ${first.name}` }));
    await waitFor(() => expect(requests).toContainEqual({ url: `/api/staff/resources/${first.id}`, method: "PATCH", body: { name: "Quiet room" } }));
  });

  it("stops using a room from its menu", async () => {
    const requests = setup();
    const first = demoResources[0]!;
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: `More for ${first.name}` }));
    await user.click(await screen.findByRole("menuitem", { name: "Stop using" }));
    await waitFor(() => expect(requests).toContainEqual({ url: `/api/staff/resources/${first.id}`, method: "PATCH", body: { isActive: false } }));
  });
});
