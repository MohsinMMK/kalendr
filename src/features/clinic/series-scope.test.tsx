/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Appointment } from "@/lib/domain";
import type { SeriesView } from "@/lib/series-contracts";

import { openVisits, SeriesScopeDialog } from "./series-scope";
import { SeriesPanel, SeriesWorkspace } from "./series-view";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const series = (over: Partial<SeriesView> = {}): SeriesView => ({
  id: "s1", status: "active", version: 3, patientId: "pt1", serviceId: "svc1", practitionerId: "p1", locationId: "l1", timezone: "Asia/Kolkata",
  rule: { frequency: "weekly", interval: 1, weekdays: [2], end: { kind: "count", count: 4 } }, ruleText: "RRULE:FREQ=WEEKLY;COUNT=4", startsOn: "2026-11-24", timeOfDay: "10:00",
  durationMinutes: 30, summary: "Every Tuesday at 10:00 am for 4 weeks", continuedFromId: null, continuedById: null,
  visits: [
    { appointmentId: "a1", index: 1, startsAt: future(-14), endsAt: future(-14), status: "completed" },
    { appointmentId: "a2", index: 2, startsAt: future(-7), endsAt: future(-7), status: "checked_in" },
    { appointmentId: "a3", index: 3, startsAt: future(7), endsAt: future(7), status: "booked" },
    { appointmentId: "a4", index: 4, startsAt: future(14), endsAt: future(14), status: "booked" },
  ],
  ...over,
});

const appointment = { id: "a3", seriesId: "s1", seriesIndex: 3, practitionerId: "p1", locationId: "l1", serviceId: "svc1", startsAt: future(7) } as Appointment;

describe("which visits a change can reach", () => {
  it("counts only booked or requested visits still ahead, never finished or checked-in ones", () => {
    expect(openVisits(series(), 1).map((visit) => visit.index)).toEqual([3, 4]);
    expect(openVisits(series(), 4).map((visit) => visit.index)).toEqual([4]);
  });
});

function dialog(action: "reschedule" | "cancel", handlers: { onThisOne?: () => void; onDone?: () => void } = {}) {
  const onOpenChange = vi.fn();
  render(<SeriesScopeDialog action={action} appointment={appointment} open onOpenChange={onOpenChange} onThisOne={handlers.onThisOne ?? vi.fn()} onDone={handlers.onDone ?? vi.fn()} />);
  return { onOpenChange };
}

describe("asking which visits to change", () => {
  it("loads the series and offers this one, this and following, or all, with counts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: series() })));
    dialog("cancel");
    expect(screen.getByText("Loading the series…")).toBeInTheDocument();
    expect(await screen.findByRole("radio", { name: /Just this one/ })).toBeChecked();
    expect(screen.getByText(/2 appointments still ahead/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /All that are still ahead/ })).toBeEnabled();
  });

  it("goes on to the ordinary screens when 'just this one' is chosen", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: series() })));
    const onThisOne = vi.fn();
    const { onOpenChange } = dialog("cancel", { onThisOne });
    await screen.findByRole("radio", { name: /Just this one/ });
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onThisOne).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cancels all that are still ahead with one request and says finished ones stay", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "PATCH"
      ? json({ data: { changed: true, seriesId: "s1", newSeriesId: null, cancelledCount: 2, bookedCount: 0, keptCount: 2 } })
      : json({ data: series() }));
    vi.stubGlobal("fetch", fetchMock);
    const onDone = vi.fn();
    dialog("cancel", { onDone });
    await user.click(await screen.findByRole("radio", { name: /All that are still ahead/ }));
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByText(/already finished or checked in stay as they are/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel 2 appointments" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ action: "cancel", scope: "all", fromAppointmentId: "a3", expectedVersion: 3 });
    expect((patch[1] as RequestInit).headers).toMatchObject({ "Idempotency-Key": expect.any(String) });
  });

  it("says what is wrong when the series cannot be loaded and lets staff try again", async () => {
    const user = userEvent.setup();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (calls += 1) === 1 ? json({ error: { code: "internal_error", message: "The request could not be completed." } }, 500) : json({ data: series() })));
    dialog("reschedule");
    expect(await screen.findByText("The request could not be completed.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByRole("radio", { name: /Just this one/ })).toBeInTheDocument();
  });
});

describe("the repeating panel and the series screen", () => {
  it("tells a visit where it sits in the series", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: series() })));
    render(<SeriesPanel seriesId="s1" appointmentId="a3" />);
    expect(await screen.findByText("Every Tuesday at 10:00 am for 4 weeks")).toBeInTheDocument();
    expect(screen.getByText(/Visit 3 of 4/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See every visit" })).toHaveAttribute("href", "/appointments/series/s1");
  });

  it("lists every visit with its status, and links the series it continues", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: series({ continuedFromId: "s0" }) })));
    render(<SeriesWorkspace seriesId="s1" returnTo="schedule" />);
    const list = await screen.findByRole("list", { name: /Every visit/ });
    expect(list.querySelectorAll("li")).toHaveLength(4);
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Checked in")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Earlier part of this series" })).toHaveAttribute("href", "/appointments/series/s0");
  });

  it("shows an empty series and a load failure with a way back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: series({ visits: [] }) })));
    render(<SeriesWorkspace seriesId="s1" returnTo="schedule" />);
    expect(await screen.findByText("No appointments in this series")).toBeInTheDocument();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "series_not_found", message: "That repeating series was not found." } }, 404)));
    render(<SeriesWorkspace seriesId="gone" returnTo="schedule" />);
    expect(await screen.findByText("That repeating series was not found.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to Schedule/ })).toBeInTheDocument();
  });
});
