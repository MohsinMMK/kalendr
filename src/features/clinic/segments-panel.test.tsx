/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { permissionKeys } from "@/lib/permissions";
import type { DuplicatePair } from "@/lib/customer-contracts";
import type { SegmentSummary } from "@/lib/segment-filter";
import { chooseOption } from "@/test/choose-option";
import { installFetch, json, stubKeys } from "@/test/offers-fixtures";
import { TestQueryProvider } from "@/test/query-wrapper";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { SegmentBuilder } from "./segment-builder";
import { DuplicatesPanel, SegmentsPanel } from "./segments-panel";
import { StaffAccessProvider } from "./staff-access";

function renderWith(node: React.ReactNode, permissions: readonly (typeof permissionKeys)[number][] = permissionKeys) {
  return render(<TestQueryProvider><StaffAccessProvider role="owner" permissions={permissions} userId="u1">{node}</StaffAccessProvider></TestQueryProvider>);
}

const segment = (patch: Partial<SegmentSummary> = {}): SegmentSummary => ({ id: "s1", name: "Lapsed regulars", filter: { all: [{ field: "lastVisit", op: "olderThanDays", days: 90 }, { field: "visits", op: "gt", value: 3 }] }, version: 1, count: 12, updatedAt: "2026-06-01T09:00:00.000Z", ...patch });

beforeEach(() => stubKeys());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("segment builder", () => {
  it("updates the count as conditions change and saves the filter", async () => {
    const user = userEvent.setup();
    const counts: Record<string, number> = {};
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/segments/preview") {
        const filter = (request.body as { filter: { all: { field: string; value?: number }[] } }).filter;
        const visits = filter.all.find((condition) => condition.field === "visits");
        const count = visits ? 5 : 40;
        counts[JSON.stringify(filter)] = count;
        return json({ count });
      }
      if (url.pathname === "/api/staff/customer-tags") return json([]);
      if (url.pathname === "/api/staff/segments" && request.method === "POST") return json(segment(), 201);
      return undefined;
    });
    renderWith(<SegmentBuilder segment={null} open onOpenChange={() => undefined} />);
    expect(await screen.findByTestId("segment-count")).toHaveTextContent("40");
    await user.click(screen.getByRole("button", { name: "Add a condition" }));
    await waitFor(() => expect(screen.getByTestId("segment-count")).toHaveTextContent("5"));
    await user.type(screen.getByLabelText("Name"), "Lapsed regulars");
    await user.click(screen.getByRole("button", { name: "Create segment" }));
    await waitFor(() => expect(requests.some((request) => request.method === "POST" && request.url === "/api/staff/segments")).toBe(true));
    const saved = requests.find((request) => request.method === "POST" && request.url === "/api/staff/segments");
    expect(saved?.body).toMatchObject({ name: "Lapsed regulars", filter: { all: [{ field: "lastVisit" }, { field: "visits", op: "gt" }] } });
  });

  it("holds the count back while a service condition has nothing chosen", async () => {
    const user = userEvent.setup();
    const requests = installFetch((_request, url) => url.pathname === "/api/staff/customer-tags" ? json([]) : url.pathname === "/api/staff/segments/preview" ? json({ count: 3 }) : undefined);
    renderWith(<SegmentBuilder segment={null} open onOpenChange={() => undefined} />);
    await screen.findByTestId("segment-count");
    await chooseOption(user, screen.getByRole("combobox", { name: "Condition 1 field" }), "Service used");
    expect(await screen.findByText(/Finish each condition/)).toBeInTheDocument();
    const before = requests.filter((request) => request.url.endsWith("/preview")).length;
    expect(before).toBe(1);
  });
});

describe("segments panel", () => {
  it("lists segments with their count and plain-words conditions, and explains the empty state", async () => {
    installFetch((_r, url) => url.pathname === "/api/staff/segments" ? json([segment()]) : url.pathname === "/api/staff/customer-tags" ? json([]) : undefined);
    const { unmount } = renderWith(<SegmentsPanel onOpenCustomer={() => undefined} />);
    expect(await screen.findByText("Lapsed regulars")).toBeInTheDocument();
    expect(screen.getByText(/No visit in 90 days, and more than 3 visits/)).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    unmount();
    installFetch((_r, url) => url.pathname === "/api/staff/segments" ? json([]) : url.pathname === "/api/staff/customer-tags" ? json([]) : undefined);
    renderWith(<SegmentsPanel onOpenCustomer={() => undefined} />);
    expect(await screen.findByText("No segments yet")).toBeInTheDocument();
  });

  it("hides editing from someone who may not manage customers", async () => {
    installFetch((_r, url) => url.pathname === "/api/staff/segments" ? json([segment()]) : url.pathname === "/api/staff/customer-tags" ? json([]) : undefined);
    renderWith(<SegmentsPanel onOpenCustomer={() => undefined} />, ["campaigns.manage"]);
    await screen.findByText("Lapsed regulars");
    expect(screen.queryByRole("button", { name: "New segment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Lapsed regulars" })).not.toBeInTheDocument();
  });
});

describe("duplicates panel", () => {
  const pair: DuplicatePair = {
    reasons: ["Same phone number"],
    a: { id: "p1", name: "Asha Rao", phone: "+919822200001", email: "asha@example.com", dateOfBirth: null, visits: 3, lastVisitAt: "2026-05-01T09:00:00.000Z" },
    b: { id: "p2", name: "Asha Rao", phone: "098222 00001", email: "", dateOfBirth: null, visits: 1, lastVisitAt: null },
  };

  it("reviews a pair side by side and merges keeping the chosen profile", async () => {
    const user = userEvent.setup();
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/customers/merge" && request.method === "GET") return json([pair]);
      if (url.pathname === "/api/staff/customers/merge" && request.method === "POST") return json({ mergeId: "m1", keptId: "p2", undoUntil: "2026-07-01T00:00:00.000Z", moved: { appointments: 1, payments: 0, invoices: 0, other: 0 } }, 201);
      return undefined;
    });
    renderWith(<DuplicatesPanel />);
    expect(await screen.findByText("Same phone number")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review Asha Rao and Asha Rao" }));
    await user.click(await screen.findByRole("radio", { name: "Keep Asha Rao", checked: false }).catch(() => screen.getAllByRole("radio")[1]!));
    await user.click(screen.getByRole("button", { name: /and merge$/ }));
    await waitFor(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    const post = requests.find((request) => request.method === "POST");
    expect(post?.body).toEqual({ keepId: "p2", mergeId: "p1" });
    expect(post?.headers["Idempotency-Key"]).toMatch(/^key-/);
  });

  it("shows no Review button without the merge permission", async () => {
    installFetch((_r, url) => url.pathname === "/api/staff/customers/merge" ? json([pair]) : undefined);
    renderWith(<DuplicatesPanel />, ["customers.manage"]);
    await screen.findByText("Same phone number");
    expect(screen.queryByRole("button", { name: /Review/ })).not.toBeInTheDocument();
  });

  it("says when there are none", async () => {
    installFetch((_r, url) => url.pathname === "/api/staff/customers/merge" ? json([]) : undefined);
    renderWith(<DuplicatesPanel />);
    expect(await screen.findByText("No possible duplicates")).toBeInTheDocument();
  });
});
