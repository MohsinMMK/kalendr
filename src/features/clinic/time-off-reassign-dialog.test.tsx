/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TimeOffReassignDialog } from "./time-off-reassign-dialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const view = {
  timeOffId: "t1", practitionerId: "p1", coverPractitionerId: "p2", coverName: "Dr Rao",
  bookings: [
    { appointmentId: "a1", version: 1, startsAt: "2030-01-01T09:00:00.000Z", endsAt: "2030-01-01T09:30:00.000Z", serviceName: "Checkup", customerName: "Asha", coverFree: true },
    { appointmentId: "a2", version: 1, startsAt: "2030-01-01T10:00:00.000Z", endsAt: "2030-01-01T10:30:00.000Z", serviceName: "Checkup", customerName: "Ben", coverFree: false },
  ],
};
const people = [{ id: "p3", name: "Dr Lee" }];

function open() {
  render(<TimeOffReassignDialog open onOpenChange={() => {}} timeOffId="t1" people={people} locale="en-GB" zone="UTC" />);
}

describe("TimeOffReassignDialog", () => {
  it("lists the bookings with a word for each, then moves them and offers the leftovers to someone else", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { toPractitionerId?: string };
        return json({ data: body.toPractitionerId ? { moved: 1, needsPerson: [] } : { moved: 1, needsPerson: [{ appointmentId: "a2", reason: "Dr Rao is busy then." }] } });
      }
      return json({ data: view });
    }));
    open();
    expect(await screen.findByText("Free for Dr Rao")).toBeInTheDocument();
    expect(screen.getByText("Busy - will need a person")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Move 2 bookings to Dr Rao" }));
    expect(await screen.findByText("Moved 1. 1 needs a person.")).toBeInTheDocument();
    expect(screen.getByText("Needs a person")).toBeInTheDocument();
    expect(screen.getByText("Dr Rao is busy then.")).toBeInTheDocument();
    const post = calls.find((call) => call.init?.method === "POST")!;
    expect(post.url).toBe("/api/staff/routing/leave-reassign");
    expect(JSON.parse(String(post.init!.body))).toEqual({ timeOffId: "t1" });
    expect((post.init!.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(screen.getByRole("button", { name: "Give to" })).toBeDisabled();

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Dr Lee" }));
    await user.click(screen.getByRole("button", { name: "Give to" }));
    await waitFor(() => expect(screen.queryByText("Needs a person")).not.toBeInTheDocument());
    const give = calls.filter((call) => call.init?.method === "POST")[1]!;
    expect(JSON.parse(String(give.init!.body))).toEqual({ timeOffId: "t1", toPractitionerId: "p3", appointmentIds: ["a2"] });
  });

  it("says when there is nothing to move", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: { ...view, bookings: [] } })));
    open();
    expect(await screen.findByText("No bookings to move.")).toBeInTheDocument();
  });

  it("shows the error and loads again on Retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "x", message: "Could not load them." } }, 500))
      .mockResolvedValueOnce(json({ data: view }));
    vi.stubGlobal("fetch", fetchMock);
    open();
    expect(await screen.findByText("Could not load them.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Free for Dr Rao")).toBeInTheDocument();
  });
});
