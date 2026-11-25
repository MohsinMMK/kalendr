/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staffSnapshotFixture } from "@/test/staff-fixture";

import { BrandSettingsPanel } from "./brand-settings";
import { DomainSettingsPanel } from "./domain-settings";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

interface Call { url: string; method: string; body?: unknown }

function run(handler: (call: Call) => Response | null, element: React.ReactElement) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const call: Call = { url, method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : undefined };
    if (url === "/api/staff/snapshot") return new Response(JSON.stringify({ data: staffSnapshotFixture }));
    calls.push(call);
    return handler(call) ?? new Response("{}", { status: 404 });
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StaffSnapshotProvider role="owner">{element}</StaffSnapshotProvider>
    </QueryClientProvider>,
  );
  return calls;
}
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

const brandView = (settings = { accent: null as string | null, corners: "soft", hideBadge: false }) => ({ settings, notes: [], logoUrl: null, coverUrl: null, canHideBadge: false });

describe("the branding screen", () => {
  it("tells the owner when a light colour gets dark text, and saves the whole look", async () => {
    let saved: unknown;
    const calls = run((call) => {
      if (call.url === "/api/staff/brand" && call.method === "GET") return ok(brandView());
      if (call.url === "/api/staff/brand" && call.method === "PUT") { saved = call.body; return ok(brandView(call.body as never)); }
      return null;
    }, <BrandSettingsPanel />);
    const user = userEvent.setup();
    await screen.findByText("Accent colour");
    expect(screen.getByRole("button", { name: "Save branding" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Use #f5b800" }));
    expect(await screen.findByRole("status")).toHaveTextContent("light, so buttons use dark text");
    // The preview uses the same variables the real page does.
    expect(screen.getByRole("img", { name: "Preview on phone" })).toHaveStyle({ "--primary": "#f5b800", "--primary-foreground": "#000000" });
    await user.click(screen.getByRole("tab", { name: "Desktop" }));
    expect(screen.getByRole("img", { name: "Preview on desktop" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save branding" }));
    await waitFor(() => expect(saved).toEqual({ accent: "#f5b800", corners: "soft", hideBadge: false }));
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("refuses a colour that is not a plain colour code and keeps Save off", async () => {
    run((call) => (call.url === "/api/staff/brand" ? ok(brandView()) : null), <BrandSettingsPanel />);
    const user = userEvent.setup();
    await screen.findByText("Accent colour");
    await user.type(screen.getByLabelText("Accent colour"), "red");
    expect(await screen.findByText("Use a colour code like #0f766e.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save branding" })).toBeDisabled();
  });

  it("shows an error with a way to retry", async () => {
    let attempts = 0;
    run((call) => {
      if (call.url !== "/api/staff/brand") return null;
      attempts += 1;
      return attempts === 1 ? new Response(JSON.stringify({ error: { code: "internal_error", message: "Branding could not be loaded." } }), { status: 500 }) : ok(brandView());
    }, <BrandSettingsPanel />);
    const user = userEvent.setup();
    expect(await screen.findByText("Branding could not be loaded.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Accent colour")).toBeVisible();
  });
});

const record = (hostname: string, state: string, extra: Record<string, unknown> = {}) => ({
  id: "d1", hostname, state, lastCheckedAt: null, lastResult: null, checkUntil: null, missingSince: null,
  records: { cname: { name: hostname, value: "edge.kalendr.example" }, txt: { name: `_kalendr-verify.${hostname}` } }, ...extra,
});

describe("the own web address screen", () => {
  it("walks through the four steps: add, see the two records, check, wait for the worker", async () => {
    let domains: unknown[] = [];
    const calls = run((call) => {
      if (call.url === "/api/staff/domains" && call.method === "GET") return ok({ configured: true, cnameTarget: "edge.kalendr.example", domains });
      if (call.url === "/api/staff/domains" && call.method === "POST") {
        domains = [record("book.acme.test", "pending")];
        return ok({ domain: domains[0], txtValue: `kalendr-verify=${"a".repeat(64)}` }, 201);
      }
      if (call.url === "/api/staff/domains/d1/verify") return ok({ queued: true }, 202);
      return null;
    }, <DomainSettingsPanel />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Address"), "book.acme.test");
    await user.click(screen.getByRole("button", { name: "Add address" }));
    expect(await screen.findByText("Waiting for records")).toBeVisible();
    expect(screen.getByText("edge.kalendr.example")).toBeVisible();
    expect(screen.getByText("_kalendr-verify.book.acme.test")).toBeVisible();
    expect(screen.getByText(`kalendr-verify=${"a".repeat(64)}`)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/staff/domains/d1/verify" && call.method === "POST")).toBe(true));
  });

  it("shows a live address with a link, and warns when the records have gone", async () => {
    run((call) => (call.url === "/api/staff/domains" ? ok({ configured: true, cnameTarget: "edge.kalendr.example", domains: [record("book.acme.test", "live"), record("two.acme.test", "warning", { id: "d2", missingSince: new Date().toISOString() })] }) : null), <DomainSettingsPanel />);
    expect(await screen.findByText("Live")).toBeVisible();
    expect(screen.getByRole("link", { name: "https://book.acme.test" })).toHaveAttribute("href", "https://book.acme.test");
    expect(screen.getByText(/Put them back within 7 days/)).toBeVisible();
  });

  it("explains plainly when the deployment has no target, and disables adding", async () => {
    run((call) => (call.url === "/api/staff/domains" ? ok({ configured: false, cnameTarget: null, domains: [] }) : null), <DomainSettingsPanel />);
    expect(await screen.findByText(/not set up on this Kalendr yet/)).toBeVisible();
    expect(screen.getByLabelText("Address")).toBeDisabled();
  });

  it("shows the server's message under the field for an address it cannot use", async () => {
    run((call) => {
      if (call.url === "/api/staff/domains" && call.method === "GET") return ok({ configured: true, cnameTarget: "edge.kalendr.example", domains: [] });
      if (call.url === "/api/staff/domains" && call.method === "POST") return new Response(JSON.stringify({ error: { code: "validation_error", message: "bad", fieldErrors: { hostname: ["Enter an address like book.yourbusiness.com."] } } }), { status: 400 });
      return null;
    }, <DomainSettingsPanel />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Address"), "acme.test");
    await user.click(screen.getByRole("button", { name: "Add address" }));
    const field = await screen.findAllByText("Enter an address like book.yourbusiness.com.");
    expect(within(field[0]!.closest("form")!).getByLabelText("Address")).toBeInvalid();
  });
});
