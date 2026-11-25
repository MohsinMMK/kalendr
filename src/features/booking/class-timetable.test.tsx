/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TimetableSession } from "@/lib/classes-contracts";

import { ClassTimetable, weekRange } from "./class-timetable";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

const session = (over: Partial<TimetableSession> = {}): TimetableSession => ({
  id: "s1", serviceId: "svc1", serviceName: "Morning yoga", locationId: "loc1", startsAt: soon(26), endsAt: soon(27), teacherName: "Asha Rao",
  capacity: 10, seatsLeft: 3, state: "open", priceMinor: 50_000, currency: "INR", ...over,
});

const places = [{ id: "loc1", name: "Main studio", timezone: "Asia/Kolkata" }];
const show = (initial: TimetableSession[] | null) => render(
  <ClassTimetable clinicSlug="lotus" businessName="Lotus Studio" businessZone="Asia/Kolkata" locale="en-IN" places={places} initialSessions={initial} />,
);

describe("the class timetable", () => {
  it("lists classes by day with seats left, a warning near full, and the waiting list when full", () => {
    show([
      session(),
      session({ id: "s2", serviceId: "svc2", serviceName: "Evening pilates", seatsLeft: 8, startsAt: soon(28), endsAt: soon(29) }),
      session({ id: "s3", serviceId: "svc3", serviceName: "Strength", seatsLeft: 0, state: "full", startsAt: soon(30), endsAt: soon(31) }),
      session({ id: "s4", serviceId: "svc4", serviceName: "Late class", state: "closed", seatsLeft: 2, startsAt: soon(32), endsAt: soon(33) }),
    ]);
    expect(screen.getByRole("heading", { level: 1, name: "Class timetable" })).toBeInTheDocument();
    expect(screen.getByText("3 left")).toBeInTheDocument();
    expect(screen.getByText("8 left")).toBeInTheDocument();
    expect(screen.getByText("Full: join the waiting list")).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.getAllByText("Asha Rao").length).toBeGreaterThan(0);
    expect(screen.getAllByText("₹500").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Book a seat: Morning yoga/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Join waiting list: Strength/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Late class/ })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Location" })).toBeNull();
  });

  it("shows a loading state, then the empty state when the week has no classes", async () => {
    let finish: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    show(null);
    expect(screen.getByRole("status", { name: "Loading the timetable" })).toBeInTheDocument();
    finish(json({ data: { sessions: [] } }));
    expect(await screen.findByRole("heading", { name: "No classes in this week" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "See next week" })).toBeInTheDocument();
  });

  it("says what went wrong and offers Retry", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "x", message: "The timetable is busy." } }, 500))
      .mockResolvedValueOnce(json({ data: { sessions: [session()] } }));
    vi.stubGlobal("fetch", fetchMock);
    show(null);
    expect(await screen.findByText("The timetable is busy.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("3 left")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches the next seven days when the week arrow is used", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => json({ data: { sessions: [session({ id: "later", serviceName: "Next week class" })] } }));
    vi.stubGlobal("fetch", fetchMock);
    show([session()]);
    expect(screen.getByRole("button", { name: "Previous week" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next week" }));
    expect(await screen.findByText("Next week class")).toBeInTheDocument();
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    const query = new URL(url, "http://x").searchParams;
    expect(query.get("clinicSlug")).toBe("lotus");
    const expected = weekRange(1, "Asia/Kolkata");
    expect(Math.abs(Date.parse(query.get("from")!) - expected.from.getTime())).toBeLessThan(60_000);
    expect(screen.getByRole("button", { name: "Previous week" })).toBeEnabled();
  });

  it("opens the enrol dialog for the class chosen", async () => {
    const user = userEvent.setup();
    show([session(), session({ id: "s2", serviceId: "svc2", serviceName: "Evening pilates", startsAt: soon(28), endsAt: soon(29) })]);
    await user.click(screen.getByRole("button", { name: /Book a seat: Evening pilates/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Book a seat" })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText("First name")).toBeInTheDocument());
  });
});
