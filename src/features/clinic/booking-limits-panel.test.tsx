/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BookingLimitsView } from "@/lib/booking-limits";
import { TestQueryProvider } from "@/test/query-wrapper";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { BookingLimitsPanel, minutesParts, payloadFrom, formFromView } from "./booking-limits-panel";
import { ServiceLimitsTab } from "./service-limits-tab";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = (patch: Partial<BookingLimitsView> = {}): BookingLimitsView => ({
  target: { scope: "service", scopeId: "svc1" }, team: null, limits: [], serviceRules: null, ...patch,
});
const limit = (patch: Record<string, unknown>) => ({ id: "lim1", scope: "service", scopeId: "svc1", measure: "count", period: "day", maxValue: 8, weekStart: 1, ...patch });

type Handler = (method: string, body: unknown) => Response;

function setup(ui: React.ReactElement, handler: Handler) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/staff/snapshot") return new Response(JSON.stringify({ data: staffSnapshotFixture }));
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    requests.push({ url, method, body });
    return handler(method, body);
  }));
  render(<TestQueryProvider><StaffSnapshotProvider role="owner">{ui}</StaffSnapshotProvider></TestQueryProvider>);
  return requests;
}
const ok = (data: unknown) => new Response(JSON.stringify({ data }));

describe("limit helpers", () => {
  it("splits minutes into hours and minutes", () => {
    expect(minutesParts(90)).toEqual({ hours: 1, minutes: 30 });
    expect(minutesParts(Number.NaN)).toEqual({ hours: 0, minutes: 0 });
  });

  it("sends the customer rules only for a service and the team only for a team", () => {
    const values = formFromView(view({ limits: [limit({}) as never], serviceRules: { maxActivePerCustomer: 2, offerRescheduleWhenCapped: true, firstSlotOnly: false } }));
    const target = { scope: "service" as const, scopeId: "svc1" };
    expect(payloadFrom(target, values, { serviceRules: true })).toMatchObject({ serviceRules: { maxActivePerCustomer: 2 } });
    expect(payloadFrom(target, values, {})).not.toHaveProperty("serviceRules");
    expect(payloadFrom(target, values, {})).not.toHaveProperty("team");
  });
});

describe("booking limits panel", () => {
  it("says it is unavailable without a database", () => {
    render(<BookingLimitsPanel scope="service" scopeId="svc1" />);
    expect(screen.getByText(/not available in the preview/i)).toBeInTheDocument();
  });

  it("lists the saved limits in plain words", async () => {
    setup(<BookingLimitsPanel scope="service" scopeId="svc1" />, () => ok(view({ limits: [limit({}), limit({ id: "l2", measure: "minutes", period: "week", maxValue: 1200 })] as never })));
    expect(await screen.findByText("8 bookings a day", { selector: "p.text-xs" })).toBeInTheDocument();
    expect(screen.getByText("20 hours booked a week", { selector: "p.text-xs" })).toBeInTheDocument();
    expect(screen.getByLabelText("Limit 2: the week starts on")).toBeInTheDocument();
  });

  it("shows an empty state when there are no limits", async () => {
    setup(<BookingLimitsPanel scope="service" scopeId="svc1" />, () => ok(view()));
    expect(await screen.findByText("No limits yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save limits" })).toBeDisabled();
  });

  it("adds a limit and saves the whole list", async () => {
    const requests = setup(<BookingLimitsPanel scope="service" scopeId="svc1" />, (method) => method === "PUT" ? ok(view({ limits: [limit({ maxValue: 5 })] as never })) : ok(view()));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add a limit" }));
    await user.click(await screen.findByRole("menuitem", { name: /Bookings a day/ }));
    const amount = await screen.findByLabelText("Limit 1: most bookings");
    await user.clear(amount);
    await user.type(amount, "5");
    await user.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(requests.find((request) => request.method === "PUT")?.body).toEqual({
      target: { scope: "service", scopeId: "svc1" },
      limits: [{ measure: "count", period: "day", maxValue: 5, weekStart: 1 }],
    }));
    expect(await screen.findByText(/In force now: 5 bookings a day/)).toBeInTheDocument();
  });

  it("sends booked time as minutes", async () => {
    const requests = setup(<BookingLimitsPanel scope="service" scopeId="svc1" />, (method) => method === "PUT" ? ok(view()) : ok(view()));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add a limit" }));
    await user.click(await screen.findByRole("menuitem", { name: /Booked time a day/ }));
    const hours = await screen.findByLabelText("Limit 1: hours");
    await user.clear(hours);
    await user.type(hours, "6");
    const minutes = screen.getByLabelText("Limit 1: minutes");
    await user.clear(minutes);
    await user.type(minutes, "30");
    await user.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect((requests.find((request) => request.method === "PUT")?.body as { limits: unknown[] }).limits).toEqual([{ measure: "minutes", period: "day", maxValue: 390, weekStart: 1 }]));
  });

  it("shows a server field error beside the row", async () => {
    setup(<BookingLimitsPanel scope="service" scopeId="svc1" />, (method) => method === "PUT"
      ? new Response(JSON.stringify({ error: { code: "validation_error", message: "Check the limits.", fieldErrors: { "limits.0.period": ["There is already a limit like this. Change that one instead."] } } }), { status: 422 })
      : ok(view({ limits: [limit({})] as never })));
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Limit 1: most bookings"));
    await user.type(screen.getByLabelText("Limit 1: most bookings"), "0");
    await user.click(screen.getByRole("button", { name: "Save limits" }));
    expect(await screen.findByText("There is already a limit like this. Change that one instead.")).toBeInTheDocument();
  });

  it("removes a limit from its menu", async () => {
    const requests = setup(<BookingLimitsPanel scope="service" scopeId="svc1" />, (method) => method === "PUT" ? ok(view()) : ok(view({ limits: [limit({})] as never })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More for limit 1" }));
    await user.click(await screen.findByRole("menuitem", { name: /Remove this limit/ }));
    await user.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect((requests.find((request) => request.method === "PUT")?.body as { limits: unknown[] }).limits).toEqual([]));
  });

  it("offers a retry when the limits cannot be loaded", async () => {
    let calls = 0;
    const requests = setup(<BookingLimitsPanel scope="service" scopeId="svc1" />, () => (++calls === 1 ? new Response(JSON.stringify({ error: { code: "x", message: "Nope." } }), { status: 500 }) : ok(view())));
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No limits yet")).toBeInTheDocument();
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(2);
  });
});

describe("service limits tab", () => {
  it("saves the customer rules together with the limits", async () => {
    const dirty = vi.fn();
    const requests = setup(<ServiceLimitsTab serviceId="svc1" onLimitsDirtyChange={dirty} />, (method) => method === "PUT"
      ? ok(view({ serviceRules: { maxActivePerCustomer: 2, offerRescheduleWhenCapped: true, firstSlotOnly: true } }))
      : ok(view({ serviceRules: { maxActivePerCustomer: null, offerRescheduleWhenCapped: false, firstSlotOnly: false } })));
    const user = userEvent.setup();
    const cap = await screen.findByLabelText(/Most future bookings one .* can hold/);
    await user.type(cap, "2");
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(true));
    await user.click(screen.getByRole("switch", { name: /offer them a link to move their booking/ }));
    await user.click(screen.getByRole("switch", { name: /only their first free time of the day/ }));
    await user.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(requests.find((request) => request.method === "PUT")?.body).toEqual({
      target: { scope: "service", scopeId: "svc1" },
      limits: [],
      serviceRules: { maxActivePerCustomer: 2, offerRescheduleWhenCapped: true, firstSlotOnly: true },
    }));
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  });
});
