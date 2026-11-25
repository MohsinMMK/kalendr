/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter, type OnUrlUpdateFunction } from "nuqs/adapters/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BookingPage, BookingRow, BulkResult } from "@/lib/bookings-list";
import { chooseOption } from "@/test/choose-option";
import { TestQueryProvider } from "@/test/query-wrapper";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { BookingsWorkspace } from "./bookings-workspace";
import { appointmentDateTime } from "./clinic-format";
import type { Permission } from "@/lib/permissions";

import { StaffAccessProvider } from "./staff-access";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";
import { WorkspaceLayoutProvider } from "./workspace-layout-provider";
import { emptyWorkspaceLayout } from "@/lib/workspace-layout";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const names = ["Meera Joshi", "Karan Shah", "Neha Rao", "Omar Khan", "Priya Nair"];
function makeRow(index: number, patch: Partial<BookingRow> = {}): BookingRow {
  return {
    id: `apt_${index}`, version: index + 1, startsAt: `2030-03-0${index + 1}T10:30:00+05:30`, endsAt: `2030-03-0${index + 1}T11:00:00+05:30`,
    status: "booked", bookingSource: "online",
    customer: { id: `pat_${index}`, name: names[index], phone: `+91 98000 0000${index}` },
    service: { id: "service_cleaning", name: "Routine cleaning" }, practitioner: { id: "practitioner_asha", name: "Dr. Asha Mehta" },
    location: { id: "loc_indiranagar", name: "Indiranagar" }, priceMinor: 50000, referrerHost: "google.com", utmSource: "google", utmCampaign: "spring",
    rescheduleRequestedAt: null, proposedCount: 0, ...patch,
  };
}
const rows = names.map((_, index) => makeRow(index));
const counts = { upcoming: 5, needs_approval: 2, past: 40, cancelled: 3 };

interface Call { url: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> }
let calls: Call[];
let handlers: Partial<Record<string, (url: URL, call: Call) => Response | undefined>>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : data), { status });
const page = (list: BookingRow[], extra: Partial<BookingPage> = {}): BookingPage => ({ rows: list, nextCursor: null, counts, ...extra });
const listCalls = () => calls.filter((call) => call.url.startsWith("/api/staff/bookings?"));
const lastList = () => new URL(listCalls().at(-1)!.url, "http://x").searchParams;

beforeEach(() => {
  calls = [];
  handlers = {};
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://x");
    const call: Call = { url: input, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> };
    if (url.pathname === "/api/staff/snapshot") return json(staffSnapshotFixture);
    calls.push(call);
    const custom = handlers[`${call.method} ${url.pathname}`]?.(url, call);
    if (custom) return custom;
    if (url.pathname === "/api/staff/bookings") return json(page(rows));
    if (url.pathname === "/api/staff/saved-views") return json([]);
    if (url.pathname === "/api/staff/cancel-presets") return json([{ id: "preset_power", label: "Power cut", sortOrder: 0 }]);
    return json({ error: { code: "not_found", message: "No." } }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockClear(); });

function renderBookings(search = "", { database = true, permissions }: { database?: boolean; permissions?: Permission[] } = {}) {
  const updates: URLSearchParams[] = [];
  const onUrlUpdate: OnUrlUpdateFunction = ({ searchParams }) => { updates.push(new URLSearchParams(searchParams)); };
  const workspace = <NuqsTestingAdapter searchParams={search} onUrlUpdate={onUrlUpdate} hasMemory><BookingsWorkspace /></NuqsTestingAdapter>;
  const content = permissions ? <StaffAccessProvider role="practitioner" permissions={permissions} userId={null}>{workspace}</StaffAccessProvider> : workspace;
  // The owner's arrangement of columns is kept in this browser while the test runs (preview mode), as the business's layout would be.
  render(<TestQueryProvider><WorkspaceLayoutProvider initial={emptyWorkspaceLayout} preview canEdit={!permissions}>{database ? <StaffSnapshotProvider role="owner">{content}</StaffSnapshotProvider> : content}</WorkspaceLayoutProvider></TestQueryProvider>);
  return { lastUrl: () => updates.at(-1)! };
}

describe("the bookings list", () => {
  it("shows every tab with its count and switches tab through the address and the request", async () => {
    const user = userEvent.setup();
    const view = renderBookings();
    expect(await screen.findByText("Meera Joshi")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Upcoming\s*5/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Needs approval\s*2/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Past\s*40/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Cancelled\s*3/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Repeating/ })).toBeInTheDocument();
    handlers["GET /api/staff/bookings"] = (url) => url.searchParams.get("tab") === "needs_approval" ? json(page([makeRow(0, { status: "requested" })])) : undefined;
    await user.click(screen.getByRole("tab", { name: /Needs approval/ }));
    await waitFor(() => expect(lastList().get("tab")).toBe("needs_approval"));
    expect(view.lastUrl().get("tab")).toBe("needs_approval");
    expect(await screen.findByText("Needs approval", { selector: "span" })).toBeInTheDocument();
  });

  it("reads the view from a link: tab, filters and sort", async () => {
    renderBookings("?tab=past&practitionerIds=practitioner_asha,practitioner_rohan&q=meera&sort=asc");
    await screen.findByText("Meera Joshi");
    const params = lastList();
    expect(params.get("tab")).toBe("past");
    expect(params.get("practitionerIds")).toBe("practitioner_asha,practitioner_rohan");
    expect(params.get("q")).toBe("meera");
    expect(params.get("sort")).toBe("asc");
    expect(screen.getByRole("button", { name: "Filter 2" })).toBeInTheDocument();
  });

  it("puts every filter in one dropdown and in the request", async () => {
    const user = userEvent.setup();
    const view = renderBookings();
    await screen.findByText("Meera Joshi");
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.click(screen.getByRole("combobox", { name: "Practitioner" }));
    await user.click(await screen.findByRole("option", { name: "Dr. Asha Mehta" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(lastList().get("practitionerIds")).toBe("practitioner_asha"));
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2030-03-01" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2030-03-07" } });
    await waitFor(() => expect(lastList().get("to")).toBeTruthy());
    // Midnight in the business's own time (Asia/Kolkata), and the end is the start of the day after.
    expect(lastList().get("from")).toBe("2030-02-28T18:30:00.000Z");
    expect(lastList().get("to")).toBe("2030-03-07T18:30:00.000Z");
    fireEvent.change(screen.getByLabelText(/Search .* by name or phone/), { target: { value: "meera" } });
    expect(lastList().get("q")).toBeNull();
    await waitFor(() => expect(lastList().get("q")).toBe("meera"), { timeout: 2000 });
    expect(view.lastUrl().get("q")).toBe("meera");
    expect(screen.getByRole("button", { name: "Filter 3" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastList().get("practitionerIds")).toBeNull());
    expect(lastList().get("q")).toBeNull();
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
  });

  it("applies a saved view in one step and saves the current one", async () => {
    const user = userEvent.setup();
    handlers["GET /api/staff/saved-views"] = () => json([
      { id: "v1", name: "Dr Asha next week", shared: true, mine: false, tab: "past", filters: { practitionerIds: ["practitioner_asha"] }, sort: "asc", columns: ["time", "customer", "price"] },
      { id: "v2", name: "My cancellations", shared: false, mine: true, tab: "cancelled", filters: {}, sort: "desc", columns: [] },
    ]);
    const view = renderBookings("?q=old");
    await screen.findByText("Meera Joshi");
    await user.click(screen.getByRole("button", { name: "Views" }));
    expect(await screen.findByRole("region", { name: "Shared with the team" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove view My cancellations" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove view Dr Asha next week" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Dr Asha next week/ }));
    await waitFor(() => expect(lastList().get("tab")).toBe("past"));
    expect(lastList().get("practitionerIds")).toBe("practitioner_asha");
    expect(lastList().get("q")).toBeNull();
    expect(view.lastUrl().get("sort")).toBe("asc");
    // A view brings back the columns it was saved with, in its order, and Reset columns goes back to the business's own.
    expect(view.lastUrl().get("columns")).toBe("time,customer,price");
    expect(await screen.findByRole("columnheader", { name: /Price/ })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /Service/ })).toBeNull();

    handlers["POST /api/staff/saved-views"] = () => json({ error: { code: "view_exists", message: "You already have a view called that." } }, 409);
    await user.click(screen.getByRole("button", { name: "Views" }));
    await user.click(await screen.findByRole("button", { name: /Save current view/ }));
    const dialog = await screen.findByRole("dialog", { name: "Save this view" });
    await user.type(within(dialog).getByLabelText("View name"), "Asha past");
    await user.click(within(dialog).getByRole("switch", { name: "Share with the team" }));
    await user.click(within(dialog).getByRole("button", { name: "Save view" }));
    expect(await within(dialog).findByText("You already have a view called that.")).toBeInTheDocument();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ name: "Asha past", shared: true, tab: "past", filters: { practitionerIds: ["practitioner_asha"] }, sort: "asc", columns: ["time", "customer", "price"] });
    handlers["POST /api/staff/saved-views"] = () => json({ id: "v3", name: "Asha past", shared: true, mine: true, tab: "past", filters: {}, sort: "asc", columns: [] }, 201);
    await user.click(within(dialog).getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save this view" })).toBeNull());

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reset columns" }));
    await waitFor(() => expect(view.lastUrl().get("columns")).toBeNull());
    expect(await screen.findByRole("columnheader", { name: /Service/ })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /Price/ })).toBeNull();
  });

  it("moves five selected bookings, reports 3 moved and 2 that could not, and keeps those 2 selected", async () => {
    const user = userEvent.setup();
    const failing = new Map([["apt_1", "Dr. Rohan Iyer is busy at 10:30"], ["apt_3", "Dr. Rohan Iyer is busy at 10:30"]]);
    handlers["POST /api/staff/bookings/bulk"] = (_url, call) => {
      const items = (call.body!.items as Array<{ id: string }>).map((item) => item.id);
      const results = items.map((id) => failing.has(id) ? { id, ok: false, code: "busy", message: failing.get(id) } : { id, ok: true });
      return json({ results, succeeded: 3, failed: 2 } satisfies BulkResult);
    };
    renderBookings();
    await screen.findByText("Meera Joshi");
    expect(screen.queryByRole("region", { name: "Selected bookings" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Select all loaded bookings" }));
    const bar = await screen.findByRole("region", { name: "Selected bookings" });
    expect(within(bar).getByText("5 selected")).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: "Reassign…" }));
    const dialog = await screen.findByRole("dialog", { name: /Move to another/ });
    await chooseOption(user, within(dialog).getByRole("combobox"), /Rohan/);
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    const result = await screen.findByRole("dialog", { name: "3 moved, 2 could not" });
    const post = calls.find((call) => call.url === "/api/staff/bookings/bulk")!;
    expect(post.body).toEqual({ action: "reassign", practitionerId: "practitioner_rohan", items: rows.map((row) => ({ id: row.id, expectedVersion: row.version })) });
    expect(post.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    const lines = within(result).getAllByRole("listitem").map((item) => item.textContent);
    expect(lines).toEqual([
      `Karan Shah at ${appointmentDateTime(rows[1].startsAt)}: Dr. Rohan Iyer is busy at 10:30`,
      `Omar Khan at ${appointmentDateTime(rows[3].startsAt)}: Dr. Rohan Iyer is busy at 10:30`,
    ]);
    await user.click(within(result).getByRole("button", { name: "Review them" }));
    expect(await screen.findByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: new RegExp(`Select Karan Shah`) })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: new RegExp(`Select Meera Joshi`) })).not.toBeChecked();
    // The list reloads after the run, so counts and versions are fresh for a retry.
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(1));
  });

  it("offers Confirm first on the Needs approval tab and sends a bulk confirm", async () => {
    const user = userEvent.setup();
    handlers["GET /api/staff/bookings"] = () => json(page([makeRow(0, { status: "requested" }), makeRow(1, { status: "requested" })]));
    handlers["POST /api/staff/bookings/bulk"] = () => json({ results: [{ id: "apt_0", ok: true }, { id: "apt_1", ok: true }], succeeded: 2, failed: 0 });
    renderBookings("?tab=needs_approval");
    await screen.findByText("Meera Joshi");
    await user.click(screen.getByRole("checkbox", { name: "Select all loaded bookings" }));
    await user.click(within(await screen.findByRole("region", { name: "Selected bookings" })).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("dialog", { name: "2 confirmed" })).toBeInTheDocument();
    expect(calls.find((call) => call.url === "/api/staff/bookings/bulk")?.body).toMatchObject({ action: "confirm" });
  });

  it("runs row actions: approve a request, cancel with a reason, and open a booking", async () => {
    const user = userEvent.setup();
    handlers["GET /api/staff/bookings"] = () => json(page([makeRow(0, { status: "requested" }), makeRow(1)]));
    handlers["PATCH /api/staff/appointments/apt_0"] = () => json({});
    handlers["PATCH /api/staff/appointments/apt_1"] = () => json({});
    renderBookings();
    await screen.findByText("Meera Joshi");
    const rowName = (index: number) => `Actions for ${names[index]} at ${appointmentDateTime(rows[index].startsAt)}`;
    await user.click(screen.getByRole("button", { name: rowName(0) }));
    expect(await screen.findByRole("menuitem", { name: "Decline…" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Approve" }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/staff/appointments/apt_0")?.body).toEqual({ action: "approve", expectedVersion: 1 }));
    await user.click(screen.getByRole("button", { name: rowName(1) }));
    expect(screen.queryByRole("menuitem", { name: "Approve" })).toBeNull();
    await user.click(await screen.findByRole("menuitem", { name: "Cancel with a reason…" }));
    const dialog = await screen.findByRole("dialog");
    await chooseOption(user, await within(dialog).findByRole("combobox", { name: "Reason" }), "Power cut");
    await user.click(within(dialog).getByRole("button", { name: /Cancel appointment/i }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/staff/appointments/apt_1")?.body).toMatchObject({ action: "cancel", presetId: "preset_power", expectedVersion: 2, notifyCustomer: true }));
    // A visit whose time has come can be marked as a no-show; a future one cannot.
    expect(screen.queryByRole("menuitem", { name: "Mark no-show" })).toBeNull();
    // The name itself links to the customer; the rest of the row opens the booking.
    await user.click(screen.getByText("Karan Shah").closest("td")!);
    expect(push).toHaveBeenCalledWith("/schedule?open=apt_1");
  });

  it("offers no-show only for visits whose time has come", async () => {
    const user = userEvent.setup();
    const past = makeRow(0, { startsAt: "2020-01-02T10:30:00+05:30", endsAt: "2020-01-02T11:00:00+05:30" });
    handlers["GET /api/staff/bookings"] = () => json(page([past, makeRow(1)]));
    handlers["PATCH /api/staff/appointments/apt_0"] = () => json({});
    renderBookings("?tab=past");
    await screen.findByText("Meera Joshi");
    await user.click(screen.getByRole("button", { name: `Actions for Meera Joshi at ${appointmentDateTime(past.startsAt)}` }));
    expect(await screen.findByRole("menuitem", { name: "Mark that we didn't turn up" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Mark no-show" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ action: "mark_no_show", who: "customer", expectedVersion: 1 }));
    await user.click(screen.getByRole("button", { name: `Actions for Karan Shah at ${appointmentDateTime(rows[1].startsAt)}` }));
    await screen.findByRole("menuitem", { name: "Open" });
    expect(screen.queryByRole("menuitem", { name: "Mark no-show" })).toBeNull();
  });

  it("hides what a person's permissions do not allow", async () => {
    const user = userEvent.setup();
    renderBookings("", { permissions: ["appointments.status"] });
    await screen.findByText("Meera Joshi");
    await user.click(screen.getByRole("checkbox", { name: /Select Meera Joshi/ }));
    const bar = await screen.findByRole("region", { name: "Selected bookings" });
    expect(within(bar).getByRole("button", { name: "Mark no-show" })).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Reassign…" })).toBeNull();
    await user.click(within(bar).getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Send a message…" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Cancel with a reason/ })).toBeNull();
  });

  it("pages with a cursor and keeps the tab counts", async () => {
    const user = userEvent.setup();
    handlers["GET /api/staff/bookings"] = (url) => url.searchParams.get("cursor") === "c2"
      ? json(page([makeRow(4)], { nextCursor: null, counts: null }))
      : json(page(rows.slice(0, 4), { nextCursor: "c2" }));
    renderBookings();
    await screen.findByText("Meera Joshi");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Priya Nair")).toBeInTheDocument();
    expect(lastList().get("cursor")).toBe("c2");
    expect(screen.getByRole("tab", { name: /Upcoming\s*5/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("shows, moves, renames and resets columns from the column menus, for the owner", async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    renderBookings();
    await screen.findByText("Meera Joshi");
    const headers = () => screen.getAllByRole("columnheader").map((header) => header.textContent ?? "").filter(Boolean);
    expect(screen.queryByRole("columnheader", { name: "Branch" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Branch" }));
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("columnheader", { name: "Branch" })).toBeInTheDocument();

    // From the header: move left (past the person), then rename it.
    await user.click(within(screen.getByRole("columnheader", { name: "Branch" })).getByRole("button", { name: "Branch" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move left" }));
    expect(headers()[headers().indexOf("Service") + 1]).toBe("Branch");
    await user.click(within(screen.getByRole("columnheader", { name: "Branch" })).getByRole("button", { name: "Branch" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const rename = await screen.findByRole("textbox", { name: "Name of the Branch column" });
    await user.clear(rename);
    await user.type(rename, "Site{Enter}");
    expect(await screen.findByRole("columnheader", { name: "Site" })).toBeInTheDocument();

    // Time is the one column that sorts; the others offer no sort.
    await user.click(within(screen.getByRole("columnheader", { name: "Site" })).getByRole("button", { name: "Site" }));
    expect(await screen.findByRole("menuitem", { name: "Hide" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Sort ascending" })).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reset columns" }));
    await waitFor(() => expect(screen.queryByRole("columnheader", { name: "Site" })).toBeNull());
    expect(screen.queryByRole("columnheader", { name: "Branch" })).toBeNull();
    window.localStorage.clear();
  });

  it("gives people who may not arrange columns the same table without the controls", async () => {
    window.localStorage.clear();
    renderBookings("", { permissions: ["appointments.book"] });
    await screen.findByText("Meera Joshi");
    expect(screen.queryByRole("button", { name: "Columns" })).toBeNull();
    // They can still filter from a header, but not rename, hide or move.
    const user = userEvent.setup();
    await user.click(within(screen.getByRole("columnheader", { name: /Service/ })).getByRole("button", { name: "Service" }));
    expect(await screen.findByRole("menuitem", { name: "Filter" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Hide" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Move left" })).toBeNull();
  });

  it("lets anyone go back from a saved view's columns to the business's own", async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    const view = renderBookings("?columns=time,customer,price", { permissions: ["appointments.book"] });
    await screen.findByText("Meera Joshi");
    expect(screen.getByRole("columnheader", { name: /Price/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reset columns" }));
    await waitFor(() => expect(view.lastUrl().get("columns")).toBeNull());
    expect(await screen.findByRole("columnheader", { name: /Service/ })).toBeInTheDocument();
  });

  it("shows cards on a phone", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width: 639px"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    renderBookings();
    const list = await screen.findByRole("list", { name: "Bookings" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByRole("table")).toBeNull();
    expect(within(list).getByRole("link", { name: appointmentDateTime(rows[0].startsAt) })).toHaveAttribute("href", "/schedule?open=apt_0");
    expect(screen.queryByRole("button", { name: "Columns" })).toBeNull();
  });

  it("explains an empty tab and offers to clear filters", async () => {
    const user = userEvent.setup();
    handlers["GET /api/staff/bookings"] = () => json(page([], { counts: { upcoming: 0, needs_approval: 0, past: 0, cancelled: 0 } }));
    renderBookings("?tab=needs_approval");
    expect(await screen.findByText("Nothing is waiting for you")).toBeInTheDocument();
    cleanup();
    renderBookings("?q=zzz");
    expect(await screen.findByText(/No .* match these filters/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastList().get("q")).toBeNull());
  });

  it("shows an error with a way to try again", async () => {
    const user = userEvent.setup();
    let fail = true;
    handlers["GET /api/staff/bookings"] = () => fail ? json({ error: { code: "server_error", message: "The list is not available right now." } }, 500) : undefined;
    renderBookings();
    expect(await screen.findByText("The list is not available right now.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Meera Joshi")).toBeInTheDocument();
  });

  it("says the screen needs the database in the preview, and when the API says so", async () => {
    renderBookings("", { database: false });
    expect(await screen.findByText("Bookings need the database")).toBeInTheDocument();
    expect(listCalls()).toHaveLength(0);
    cleanup();
    handlers["GET /api/staff/bookings"] = () => json({ error: { code: "preview_only", message: "Preview." } }, 400);
    renderBookings();
    expect(await screen.findByText("Bookings need the database")).toBeInTheDocument();
  });
});
