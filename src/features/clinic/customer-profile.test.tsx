/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { permissionKeys } from "@/lib/permissions";
import type { CustomerNote, CustomerSummary, TimelineEntry } from "@/lib/customer-contracts";
import { installFetch, json, stubKeys } from "@/test/offers-fixtures";
import { TestQueryProvider } from "@/test/query-wrapper";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { BlockDialog } from "./customer-dialogs";
import { CustomerNotes } from "./customer-notes";
import { CustomerSummaryStrip } from "./customer-profile";
import { CustomerTimeline } from "./customer-timeline";
import { StaffAccessProvider } from "./staff-access";

function renderWith(node: React.ReactNode, permissions: readonly (typeof permissionKeys)[number][] = permissionKeys) {
  return render(<TestQueryProvider><StaffAccessProvider role="owner" permissions={permissions} userId="u1">{node}</StaffAccessProvider></TestQueryProvider>);
}

const entry = (index: number, patch: Partial<TimelineEntry> = {}): TimelineEntry => ({
  key: `visit:${index}`, kind: "visit", at: new Date(Date.UTC(2026, 5, 30 - index)).toISOString(), title: `Visit ${index}`, detail: null, status: "completed", amountMinor: null, currency: null, refId: `a${index}`, by: null, ...patch,
});
const note = (patch: Partial<CustomerNote> = {}): CustomerNote => ({ id: "n1", body: "Prefers mornings", pinned: false, authorName: "Asha", authorUserId: "u1", version: 1, createdAt: "2026-06-01T09:00:00.000Z", updatedAt: "2026-06-01T09:00:00.000Z", ...patch });
const summary = (patch: Partial<CustomerSummary> = {}): CustomerSummary => ({
  id: "p1", name: "Meera Rao", phone: "+919800000000", email: "m@example.com", nextVisit: null, lastVisit: { id: "a1", startsAt: "2026-05-01T09:00:00.000Z", serviceName: "Check-up" }, visits: 4, noShows: 1,
  balanceOwedMinor: 25_000, lifetimeValueMinor: 100_000, currency: "INR", averageGapDays: 30, packageCredits: 3, tags: [{ id: "t1", name: "VIP", color: "violet" }], pinnedNote: { id: "n1", body: "Allergic to latex", authorName: "Asha", updatedAt: "2026-06-01T09:00:00.000Z" },
  blocked: null, marketingConsent: true, recentMerge: null, ...patch,
});

beforeEach(() => stubKeys());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("customer timeline", () => {
  it("shows history newest first, loads the next page from the cursor and filters by kind", async () => {
    const user = userEvent.setup();
    const requests = installFetch((_r, url) => {
      if (!url.pathname.endsWith("/timeline")) return undefined;
      if (url.searchParams.get("kinds") === "note") return json({ entries: [entry(9, { key: "note:1", kind: "note", title: "Note", refId: null })], nextCursor: null });
      if (url.searchParams.get("cursor") === "c1") return json({ entries: [entry(3)], nextCursor: null });
      return json({ entries: [entry(1), entry(2)], nextCursor: "c1" });
    });
    renderWith(<CustomerTimeline patientId="p1" />);
    const list = await screen.findByRole("list", { name: "History, newest first" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Load older history" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "History, newest first" })).getAllByRole("listitem")).toHaveLength(3));
    expect(requests.some((request) => request.url.includes("cursor=c1"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Load older history" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(await screen.findByText("Note")).toBeInTheDocument();
    expect(requests.some((request) => request.url.includes("kinds=note"))).toBe(true);
  });

  it("explains an empty history and offers a retry after an error", async () => {
    let fail = true;
    installFetch((_r, url) => url.pathname.endsWith("/timeline") ? (fail ? new Response(JSON.stringify({ error: { code: "x", message: "Boom" } }), { status: 500 }) : json({ entries: [], nextCursor: null })) : undefined);
    const user = userEvent.setup();
    renderWith(<CustomerTimeline patientId="p1" />);
    expect(await screen.findByText("Boom")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No history yet")).toBeInTheDocument();
  });

  it("leaves out the Payments filter for someone who cannot see money", async () => {
    installFetch((_r, url) => url.pathname.endsWith("/timeline") ? json({ entries: [], nextCursor: null }) : undefined);
    renderWith(<CustomerTimeline patientId="p1" />, ["customers.manage"]);
    await screen.findByText("No history yet");
    expect(screen.queryByRole("button", { name: "Payments" })).not.toBeInTheDocument();
  });
});

describe("customer notes", () => {
  it("adds a note with an Idempotency-Key, says notes are not clinical records, and shows the author", async () => {
    const user = userEvent.setup();
    let notes: CustomerNote[] = [note()];
    const requests = installFetch((request, url) => {
      if (!url.pathname.endsWith("/notes")) return undefined;
      if (request.method === "POST") { notes = [note({ id: "n2", body: String(request.body?.body) }), ...notes]; return json(notes[0], 201); }
      return json(notes);
    });
    renderWith(<CustomerNotes patientId="p1" />);
    expect(await screen.findByText("Prefers mornings")).toBeInTheDocument();
    expect(screen.getByText(/not clinical records/i)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Add a note" }), "Call after 5pm");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByText("Call after 5pm")).toBeInTheDocument();
    const post = requests.find((request) => request.method === "POST");
    expect(post?.body).toEqual({ body: "Call after 5pm", pinned: false });
    expect(post?.headers["Idempotency-Key"]).toMatch(/^key-/);
  });

  it("hides the note box from someone who may not manage customers", async () => {
    installFetch((_r, url) => url.pathname.endsWith("/notes") ? json([note()]) : undefined);
    renderWith(<CustomerNotes patientId="p1" />, ["appointments.book"]);
    expect(await screen.findByText("Prefers mornings")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Add a note" })).not.toBeInTheDocument();
  });
});

describe("customer summary and block", () => {
  it("shows the first-three-seconds facts and a blocked warning with Unblock", async () => {
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/customers/p1") return json(summary({ blocked: { at: "2026-06-02T09:00:00.000Z", reason: "Missed four visits", byName: "Asha" } }));
      if (url.pathname.endsWith("/block") && request.method === "DELETE") return json({ blockedAt: null });
      return undefined;
    });
    const user = userEvent.setup();
    renderWith(<CustomerSummaryStrip patientId="p1" live />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Blocked from booking online");
    expect(screen.getByRole("alert")).toHaveTextContent("Missed four visits");
    expect(screen.getByText("₹250")).toBeInTheDocument();
    expect(screen.getByText("3 left")).toBeInTheDocument();
    expect(screen.getByText("Allergic to latex")).toBeInTheDocument();
    expect(screen.getByText("VIP")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unblock" }));
    await waitFor(() => expect(requests.some((request) => request.method === "DELETE")).toBe(true));
  });

  it("hides money from someone who cannot see it, and stays silent in preview", async () => {
    installFetch((_r, url) => url.pathname === "/api/staff/customers/p1" ? json(summary({ balanceOwedMinor: null, lifetimeValueMinor: null })) : undefined);
    const { unmount } = renderWith(<CustomerSummaryStrip patientId="p1" live />, ["customers.manage"]);
    await screen.findByTestId("customer-summary");
    expect(screen.queryByText("Balance owed")).not.toBeInTheDocument();
    unmount();
    const requests = installFetch(() => undefined);
    renderWith(<CustomerSummaryStrip patientId="p1" live={false} />);
    expect(requests).toHaveLength(0);
  });

  it("requires a reason before blocking, then sends it", async () => {
    const requests = installFetch((request, url) => url.pathname.endsWith("/block") && request.method === "POST" ? json({ blockedAt: "2026-06-02T09:00:00.000Z" }) : undefined);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWith(<BlockDialog patientId="p1" name="Meera Rao" open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole("button", { name: "Block" }));
    expect(await screen.findByText("Say why, so the team knows.")).toBeInTheDocument();
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
    await user.type(screen.getByLabelText(/Why are you blocking/), "Abusive to staff");
    await user.click(screen.getByRole("button", { name: "Block" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({ reason: "Abusive to staff" });
  });
});
