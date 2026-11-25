/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter, type OnUrlUpdateFunction } from "nuqs/adapters/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BookingPage } from "@/lib/bookings-list";
import type { Permission } from "@/lib/permissions";
import type { SeriesListPage, SeriesListRow } from "@/lib/series-list";
import { TestQueryProvider } from "@/test/query-wrapper";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { BookingsWorkspace } from "./bookings-workspace";
import { StaffAccessProvider } from "./staff-access";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const counts = { upcoming: 5, needs_approval: 2, past: 40, cancelled: 3 };
const customers = ["Meera Joshi", "Karan Shah", "Neha Rao"];
function makeSeries(index: number, patch: Partial<SeriesListRow> = {}): SeriesListRow {
  return {
    id: `s${index}`, version: 2, status: "active",
    customer: { id: `pat_${index}`, name: customers[index]! },
    service: { id: "svc_physio", name: "Physiotherapy" }, practitioner: { id: "p_asha", name: "Dr. Asha Mehta" }, location: { id: "loc_1", name: "Indiranagar" },
    summary: "Every Tuesday at 10:00 am for 8 weeks", timezone: "Asia/Kolkata",
    nextVisit: { appointmentId: `apt_${index}`, startsAt: "2030-03-05T10:00:00+05:30", index: 3 }, visitsDone: 2, visitsTotal: 8, ...patch,
  };
}
const seriesRows = customers.map((_, index) => makeSeries(index));
const seriesPage = (list: SeriesListRow[], extra: Partial<SeriesListPage> = {}): SeriesListPage => ({ rows: list, nextCursor: null, counts, repeatingCount: list.length, ...extra });
const bookingPage: BookingPage = { rows: [], nextCursor: null, counts, repeatingCount: 3 };
const seriesView = { id: "s0", status: "active", version: 2, patientId: "pat_0", serviceId: "svc_physio", practitionerId: "p_asha", locationId: "loc_1", timezone: "Asia/Kolkata",
  rule: { frequency: "weekly", interval: 1, weekdays: [2], end: { kind: "count", count: 8 } }, ruleText: "RRULE:FREQ=WEEKLY;COUNT=8", startsOn: "2030-02-19", timeOfDay: "10:00", durationMinutes: 30,
  summary: "Every Tuesday at 10:00 am for 8 weeks", continuedFromId: null, continuedById: null,
  visits: [{ appointmentId: "apt_0", index: 3, startsAt: "2030-03-05T10:00:00+05:30", endsAt: "2030-03-05T10:30:00+05:30", status: "booked" }, { appointmentId: "apt_x", index: 4, startsAt: "2030-03-12T10:00:00+05:30", endsAt: "2030-03-12T10:30:00+05:30", status: "booked" }] };

interface Call { url: string; method: string }
let calls: Call[];
let handlers: Partial<Record<string, (url: URL) => Response | undefined>>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : data), { status });
const seriesCalls = () => calls.filter((call) => call.url.startsWith("/api/staff/bookings/series"));
const lastSeries = () => new URL(seriesCalls().at(-1)!.url, "http://x").searchParams;

beforeEach(() => {
  calls = [];
  handlers = {};
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://x");
    if (url.pathname === "/api/staff/snapshot") return json(staffSnapshotFixture);
    const method = init?.method ?? "GET";
    calls.push({ url: input, method });
    const custom = handlers[`${method} ${url.pathname}`]?.(url);
    if (custom) return custom;
    if (url.pathname === "/api/staff/bookings/series") return json(seriesPage(seriesRows));
    if (url.pathname === "/api/staff/bookings") return json(bookingPage);
    if (url.pathname === "/api/staff/saved-views") return json([]);
    if (url.pathname === "/api/staff/series/s0") return json(seriesView);
    return json({ error: { code: "not_found", message: "No." } }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockClear(); });

function renderTab(search = "?tab=repeating", { database = true, permissions }: { database?: boolean; permissions?: Permission[] } = {}) {
  const updates: URLSearchParams[] = [];
  const onUrlUpdate: OnUrlUpdateFunction = ({ searchParams }) => { updates.push(new URLSearchParams(searchParams)); };
  const workspace = <NuqsTestingAdapter searchParams={search} onUrlUpdate={onUrlUpdate} hasMemory><BookingsWorkspace /></NuqsTestingAdapter>;
  const content = permissions ? <StaffAccessProvider role="receptionist" permissions={permissions} userId={null}>{workspace}</StaffAccessProvider> : workspace;
  render(<TestQueryProvider>{database ? <StaffSnapshotProvider role="owner">{content}</StaffSnapshotProvider> : content}</TestQueryProvider>);
  return { lastUrl: () => updates.at(-1)! };
}

describe("the Repeating tab", () => {
  it("is a fifth tab with its own count, reached from the address or a click, and asks the series route, not the booking one", async () => {
    const user = userEvent.setup();
    const view = renderTab("");
    expect(await screen.findByRole("tab", { name: /Repeating\s*3/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Upcoming\s*5/ })).toBeInTheDocument();
    expect(seriesCalls()).toHaveLength(0);
    await user.click(screen.getByRole("tab", { name: /Repeating/ }));
    expect(await screen.findByText("Meera Joshi")).toBeInTheDocument();
    expect(view.lastUrl().get("tab")).toBe("repeating");
    expect(lastSeries().get("tab")).toBeNull();
  });

  it("lists each series with what it repeats, the next visit, how many are done and its status", async () => {
    renderTab();
    const table = await screen.findByRole("table", { name: "Repeating series" });
    const first = within(table).getByRole("row", { name: /Meera Joshi/ });
    expect(within(first).getByText("Every Tuesday at 10:00 am for 8 weeks")).toBeInTheDocument();
    expect(within(first).getByText("Physiotherapy")).toBeInTheDocument();
    expect(within(first).getByText("Dr. Asha Mehta")).toBeInTheDocument();
    expect(within(first).getByText(/Tue, 5 Mar, 10:00 am/)).toBeInTheDocument();
    expect(within(first).getByText("2 of 8")).toBeInTheDocument();
    expect(within(first).getByText("Running")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Columns" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("opens the series from the customer's name, from the row and from the menu, with a way back to this tab", async () => {
    const user = userEvent.setup();
    renderTab();
    const link = await screen.findByRole("link", { name: "Meera Joshi" });
    expect(link).toHaveAttribute("href", "/appointments/series/s0?from=bookings");
    await user.click(within(screen.getByRole("row", { name: /Karan Shah/ })).getByText("Physiotherapy"));
    expect(push).toHaveBeenCalledWith("/appointments/series/s1?from=bookings");
    await user.click(screen.getByRole("button", { name: /Actions for Meera Joshi/ }));
    expect(await screen.findByRole("menuitem", { name: /See every/ })).toHaveAttribute("href", "/appointments/series/s0?from=bookings");
  });

  it("filters with the shared Filter menu: customer, person, service, branch and status only, all in the request", async () => {
    const user = userEvent.setup();
    const view = renderTab();
    await screen.findByText("Meera Joshi");
    await user.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.queryByRole("combobox", { name: "Booked via" })).toBeNull();
    expect(screen.queryByLabelText("From date")).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Ended" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(lastSeries().get("seriesStatuses")).toBe("ended"));
    expect(view.lastUrl().get("seriesStatuses")).toBe("ended");
    expect(screen.getByRole("button", { name: "Filter 1" })).toBeInTheDocument();
  });

  it("reads filters and order from a link, and the order button flips it", async () => {
    const user = userEvent.setup();
    const view = renderTab("?tab=repeating&q=meera&seriesStatuses=active,ended&serviceIds=svc_physio");
    await screen.findByText("Meera Joshi");
    expect(lastSeries().get("q")).toBe("meera");
    expect(lastSeries().get("seriesStatuses")).toBe("active,ended");
    expect(lastSeries().get("serviceIds")).toBe("svc_physio");
    expect(screen.getByRole("button", { name: "Filter 3" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Next visit, sorted soonest first/ }));
    await waitFor(() => expect(lastSeries().get("sort")).toBe("desc"));
    expect(view.lastUrl().get("sort")).toBe("desc");
  });

  it("pages with a cursor and keeps the counts", async () => {
    const user = userEvent.setup();
    handlers["GET /api/staff/bookings/series"] = (url) => url.searchParams.get("cursor")
      ? json(seriesPage([makeSeries(2)], { counts: null, repeatingCount: null }))
      : json(seriesPage([seriesRows[0]!, seriesRows[1]!], { nextCursor: "next", repeatingCount: 3 }));
    renderTab();
    await screen.findByText("Meera Joshi");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Neha Rao")).toBeInTheDocument();
    expect(lastSeries().get("cursor")).toBe("next");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
    expect(screen.getByRole("tab", { name: /Repeating\s*3/ })).toBeInTheDocument();
  });

  it("moves or cancels through the same which-visits question as a single visit of a series", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Meera Joshi");
    await user.click(screen.getByRole("button", { name: /Actions for Meera Joshi/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Cancel…" }));
    expect(await screen.findByRole("radio", { name: /Just this one/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /All that are still ahead/ })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /All that are still ahead/ }));
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByText(/2 appointments will be cancelled/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("radio", { name: /Just this one/ })).toBeInTheDocument();
  });

  it("sends 'just this one' to the visit's own screen", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Meera Joshi");
    await user.click(screen.getByRole("button", { name: /Actions for Meera Joshi/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Move…" }));
    await screen.findByRole("radio", { name: /Just this one/ });
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    expect(push).toHaveBeenCalledWith("/schedule?open=apt_0");
  });

  it("refreshes the list after a series is cancelled", async () => {
    const user = userEvent.setup();
    handlers["PATCH /api/staff/series/s0"] = () => json({ changed: true, seriesId: "s0", newSeriesId: null, cancelledCount: 2, bookedCount: 0, keptCount: 0 });
    renderTab();
    await screen.findByText("Meera Joshi");
    await user.click(screen.getByRole("button", { name: /Actions for Meera Joshi/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Cancel…" }));
    await user.click(await screen.findByRole("radio", { name: /All that are still ahead/ }));
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    const before = seriesCalls().length;
    await user.click(await screen.findByRole("button", { name: /^Cancel 2 appointments/ }));
    await waitFor(() => expect(seriesCalls().length).toBeGreaterThan(before));
  });

  it("hides what a person may not do: no change menu without series.manage, no link without appointments.book", async () => {
    renderTab("?tab=repeating", { permissions: ["appointments.status", "schedule.read"] });
    await screen.findByText("Meera Joshi");
    expect(screen.queryByRole("link", { name: "Meera Joshi" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
    cleanup();
    renderTab("?tab=repeating", { permissions: ["appointments.status", "appointments.book"] });
    await screen.findByRole("link", { name: "Meera Joshi" });
    await userEvent.setup().click(screen.getByRole("button", { name: /Actions for Meera Joshi/ }));
    expect(await screen.findByRole("menuitem", { name: /See every/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Move…" })).toBeNull();
  });

  it("offers no change for a series that has ended or has nothing ahead", async () => {
    handlers["GET /api/staff/bookings/series"] = () => json(seriesPage([makeSeries(0, { status: "ended", nextVisit: null })]));
    renderTab();
    await screen.findByText("Meera Joshi");
    await userEvent.setup().click(screen.getByRole("button", { name: /Actions for Meera Joshi/ }));
    expect(await screen.findByRole("menuitem", { name: /See every/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Cancel…" })).toBeNull();
    expect(screen.getByText("Ended")).toBeInTheDocument();
  });

  it("shows cards on a phone", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width: 639px"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    renderTab();
    const list = await screen.findByRole("list", { name: "Repeating series" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("table")).toBeNull();
    expect(within(list).getAllByText("Every Tuesday at 10:00 am for 8 weeks")).toHaveLength(3);
    expect(within(list).getAllByText(/2 of 8 done/)).toHaveLength(3);
    expect(within(list).getByRole("link", { name: "Meera Joshi" })).toHaveAttribute("href", "/appointments/series/s0?from=bookings");
  });

  it("explains an empty tab, an empty filter and offers to clear it", async () => {
    const user = userEvent.setup();
    handlers["GET /api/staff/bookings/series"] = () => json(seriesPage([], { repeatingCount: 0 }));
    renderTab();
    expect(await screen.findByText(/No repeating appointments yet/)).toBeInTheDocument();
    cleanup();
    renderTab("?tab=repeating&q=zzz");
    expect(await screen.findByText("No repeating series match these filters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastSeries().get("q")).toBeNull());
  });

  it("shows a loading state, then an error with a way to try again", async () => {
    const user = userEvent.setup();
    let fail = true;
    handlers["GET /api/staff/bookings/series"] = () => fail ? json({ error: { code: "server_error", message: "The list is not available right now." } }, 500) : undefined;
    renderTab();
    expect(await screen.findByRole("status", { name: "Loading repeating series" })).toBeInTheDocument();
    expect(await screen.findByText("The list is not available right now.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Meera Joshi")).toBeInTheDocument();
  });

  it("says the tab needs the database in the preview, and when the API says so", async () => {
    renderTab("?tab=repeating", { database: false });
    expect(await screen.findByText("Repeating bookings need the database")).toBeInTheDocument();
    expect(seriesCalls()).toHaveLength(0);
    cleanup();
    handlers["GET /api/staff/bookings/series"] = () => json({ error: { code: "preview_only", message: "Preview." } }, 400);
    renderTab();
    expect(await screen.findByText("Repeating bookings need the database")).toBeInTheDocument();
  });

  it("keeps the saved-view behaviour: a view saved on this tab reopens on it with its filters", async () => {
    const user = userEvent.setup();
    handlers["GET /api/staff/saved-views"] = () => json([{ id: "v1", name: "Ended courses", shared: false, mine: true, tab: "repeating", filters: { seriesStatuses: ["ended"] }, sort: "asc", columns: [] }]);
    const view = renderTab("");
    await screen.findByRole("tab", { name: /Repeating/ });
    await user.click(screen.getByRole("button", { name: /Views|Saved views/ }));
    await user.click(await screen.findByRole("button", { name: /^Ended courses/ }));
    await waitFor(() => expect(view.lastUrl().get("tab")).toBe("repeating"));
    expect(view.lastUrl().get("seriesStatuses")).toBe("ended");
    await waitFor(() => expect(lastSeries().get("seriesStatuses")).toBe("ended"));
  });
});
