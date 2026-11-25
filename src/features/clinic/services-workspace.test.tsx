/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BusinessProfileProvider } from "@/features/terms/business-profile-context";
import type { Service } from "@/lib/domain";
import { resolveBusinessProfile } from "@/lib/terminology";
import { demoClinic, demoServices } from "@/lib/demo-data";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const catalogState = { services: [] as Service[] };
vi.mock("./clinic-catalog", () => ({
  useCatalogLookups: () => ({ clinic: { ...demoClinic, slug: "glow" }, services: catalogState.services, database: true, snapshot: null }),
}));

const layoutState = { canEdit: true, update: vi.fn(), layout: {} as Record<string, unknown> };
vi.mock("./workspace-layout-provider", () => ({ usePageLayout: () => layoutState }));

// dnd-kit needs real layout, so the sortable is replaced by a list with a button that reverses it.
vi.mock("@/components/reui/sortable", () => ({
  Sortable: ({ children, value, onValueChange }: { children: ReactNode; value: unknown[]; onValueChange: (next: unknown[]) => void }) => (
    <div><button type="button" onClick={() => onValueChange([...value].reverse())}>test-reverse</button>{children}</div>
  ),
  SortableItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SortableItemHandle: ({ render }: { render: ReactNode }) => <>{render}</>,
}));

import { ServicesWorkspace } from "./services-workspace";

const first = demoServices[0] as Service;
const mk = (patch: Partial<Service>): Service => ({ ...first, ...patch });

function renderPage(businessType: "wellness" | "real_estate" | "professional_services" = "wellness") {
  return render(<BusinessProfileProvider profile={resolveBusinessProfile({ businessType })}><ServicesWorkspace /></BusinessProfileProvider>);
}

let calls: Array<{ url: string; method: string; body?: unknown }>;
let respond: (url: string, method: string) => Response;

beforeEach(() => {
  push.mockClear();
  layoutState.update = vi.fn();
  layoutState.canEdit = true;
  layoutState.layout = {};
  catalogState.services = [
    mk({ id: "s1", version: 7, name: "Haircut", slug: "haircut", durationMinutes: 45, priceLabel: "", isActive: true, visibility: "listed", lengths: undefined }),
    mk({ id: "s2", version: 7, name: "Colour", slug: "colour", durationMinutes: 90, isActive: true, visibility: "hidden", lengths: undefined }),
  ];
  calls = [];
  respond = () => new Response(JSON.stringify({ data: { serviceId: "new1" } }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    calls.push({ url, method, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    return respond(url, method);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("services list", () => {
  it("shows each row's name, length and a Hidden badge", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "Haircut" })).toHaveAttribute("href", "/services/s1");
    expect(screen.getByText(/45/)).toBeInTheDocument();
    const row = screen.getByRole("link", { name: "Colour" }).closest("div.min-h-14") as HTMLElement;
    expect(within(row).getByText("Hidden")).toBeInTheDocument();
    expect(screen.getAllByText("Hidden")).toHaveLength(1);
  });

  it.each([
    ["wellness", "Services", "New service"],
    ["real_estate", "Appointment Types", "New appointment type"],
    ["professional_services", "Meeting Types", "New meeting type"],
  ] as const)("uses the %s words", (type, title, action) => {
    renderPage(type);
    expect(screen.getByRole("heading", { level: 1 }).textContent?.toLowerCase()).toBe(title.toLowerCase());
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/patient|doctor|clinic/i);
  });

  it("turns a service off with a PATCH", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("switch", { name: "Haircut is on" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/staff/services/s1", method: "PATCH", body: { isActive: false } }));
  });

  it("hides a service from the booking page and shows a hidden one again", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More for Haircut" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Hide from booking page" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/staff/services/s1", method: "PATCH", body: { expectedVersion: 7, basics: { visibility: "hidden" } } }));
    await userEvent.click(screen.getByRole("button", { name: "More for Colour" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Show on booking page" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/staff/services/s2", method: "PATCH", body: { expectedVersion: 7, basics: { visibility: "listed" } } }));
  });

  it("duplicates and opens the copy", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More for Haircut" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/staff/services/s1/duplicate" && call.method === "POST")).toBe(true));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/services/new1"));
  });

  it("asks before deleting, then sends DELETE", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More for Haircut" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    await userEvent.click(await screen.findByRole("button", { name: "Delete service" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/staff/services/s1", method: "DELETE", body: undefined }));
  });

  it("filters by name and turns dragging off while searching", async () => {
    renderPage();
    expect(screen.getByRole("button", { name: /^Move Haircut/ })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "colo");
    expect(screen.queryByRole("link", { name: "Haircut" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Colour" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText("No services match")).toBeInTheDocument();
  });

  it("hides the drag handle when the layout cannot be edited", () => {
    layoutState.canEdit = false;
    renderPage();
    expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
  });

  it("saves only the new order of ids", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "test-reverse" }));
    expect(layoutState.update).toHaveBeenCalledWith({ lists: { services: { order: ["s2", "s1"] } } });
  });

  it("shows an empty state with the New action", async () => {
    catalogState.services = [];
    renderPage("real_estate");
    expect(screen.getByText("No appointment types yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New appointment type" })).toHaveLength(2);
  });

  it("creates a new one from the dialog and opens its editor", async () => {
    renderPage();
    await userEvent.click(screen.getAllByRole("button", { name: "New service" })[0]!);
    await userEvent.type(await screen.findByLabelText("Name"), "Beard trim");
    await userEvent.click(screen.getByRole("button", { name: "Create service" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/staff/services", method: "POST", body: { name: "Beard trim", description: "Beard trim", durationMinutes: 30 } }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/services/new1"));
  });

  it("shows the in-use refusal in a toast-safe way and keeps the row", async () => {
    respond = (_url, method) => method === "DELETE" ? new Response(JSON.stringify({ error: { code: "service_in_use", message: "x" } }), { status: 409 }) : new Response("{}");
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "More for Haircut" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete service" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete service" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Haircut" })).toBeInTheDocument();
  });
});
