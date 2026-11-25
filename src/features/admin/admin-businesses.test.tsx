/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BusinessesScreen } from "./businesses-screen";
import { SignupBars } from "./signups-chart";
import { data, fail, mockFetch, tenantRow, Wrap } from "./test-support";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const signups = Array.from({ length: 30 }, (_, index) => ({ day: `2026-10-${String(index + 1).padStart(2, "0")}`, signups: index === 4 ? 6 : 0 }));

function serve(list: unknown) {
  return mockFetch((url) => url.startsWith("/api/admin/signups") ? data(signups) : url.startsWith("/api/admin/tenants") ? (list as never) : fail(404, "not_found", "x"));
}

describe("Businesses", () => {
  it("shows a loading state, then the full list with plan, status, staff and set-up stage", async () => {
    serve(data({ items: [tenantRow(), tenantRow({ tenantId: "tenant-0002", name: "Salon Two", pausedAt: "2026-11-10T00:00:00.000Z", isActive: false, planKey: null, setupStage: "signed_up" })], total: 2, pageSize: 25 }));
    render(<Wrap><BusinessesScreen /></Wrap>);
    expect(screen.getByRole("status", { name: "Loading businesses" })).toBeInTheDocument();
    const list = (await screen.findAllByRole("link", { name: "City Clinic" }))[0];
    expect(list).toHaveAttribute("href", "/admin/tenants/tenant-0001");
    expect(screen.getAllByText("Paused").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pro").length).toBeGreaterThan(0);
    expect(screen.getAllByText("First booking").length).toBeGreaterThan(0);
    expect(screen.getByText("2 businesses")).toBeInTheDocument();
  });

  it("explains an empty list, and says so differently when a search found nothing", async () => {
    const calls = serve(data({ items: [], total: 0, pageSize: 25 }));
    render(<Wrap><BusinessesScreen /></Wrap>);
    expect(await screen.findByText("No businesses yet")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search businesses" }), "zzz");
    expect(await screen.findByText("No business matches")).toBeInTheDocument();
    await waitFor(() => expect(calls.some((call) => call.url.includes("search=zzz"))).toBe(true));
  });

  it("shows the error with a retry that loads the list", async () => {
    let failing = true;
    mockFetch((url) => {
      if (url.startsWith("/api/admin/signups")) return data(signups);
      return failing ? fail(500, "internal", "The database is busy.") : data({ items: [tenantRow()], total: 1, pageSize: 25 });
    });
    render(<Wrap><BusinessesScreen /></Wrap>);
    expect(await screen.findByText("The database is busy.")).toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findAllByRole("link", { name: "City Clinic" })).length).toBeGreaterThan(0);
  });

  it("keeps the list when only the sign-ups chart fails (partial)", async () => {
    mockFetch((url) => url.startsWith("/api/admin/signups") ? fail(500, "internal", "Chart data is missing.") : data({ items: [tenantRow()], total: 1, pageSize: 25 }));
    render(<Wrap><BusinessesScreen /></Wrap>);
    expect((await screen.findAllByRole("link", { name: "City Clinic" })).length).toBeGreaterThan(0);
    expect(await screen.findByText("Chart data is missing.")).toBeInTheDocument();
  });

  it("filters by status through the dropdown", async () => {
    const calls = serve(data({ items: [tenantRow()], total: 1, pageSize: 25 }));
    render(<Wrap><BusinessesScreen /></Wrap>);
    await screen.findAllByRole("link", { name: "City Clinic" });
    await userEvent.click(screen.getByRole("combobox", { name: "Show businesses" }));
    await userEvent.click(await screen.findByRole("option", { name: "Paused" }));
    await waitFor(() => expect(calls.some((call) => call.url.includes("status=paused"))).toBe(true));
  });
});

describe("sign-ups chart", () => {
  it("describes the bars in words for a screen reader", () => {
    render(<SignupBars days={signups} />);
    const image = screen.getByRole("img");
    expect(image).toHaveAccessibleName(/6 sign-ups in the last 30 days/);
  });
  it("says so when nobody signed up", () => {
    render(<SignupBars days={signups.map((entry) => ({ ...entry, signups: 0 }))} />);
    expect(screen.getByRole("img")).toHaveAccessibleName("No sign-ups in the last 30 days.");
  });
});
