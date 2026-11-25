import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HistoryEntry } from "@/lib/bookings-list";

import { BookingHistory } from "./booking-history";

const entries: HistoryEntry[] = [
  { at: "2026-11-20T05:00:00.000Z", kind: "audit", action: "created", label: "Booked", actor: { type: "patient" } },
  { at: "2026-11-21T05:00:00.000Z", kind: "audit", action: "reassigned", label: "Changed practitioner", detail: "Dr Rao → Dr Shah", actor: { type: "staff", name: "Priya" } },
  { at: "2026-11-22T05:00:00.000Z", kind: "message", action: "reminder", label: "Reminder sent", actor: { type: "system" } },
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubFetch(...responses: Array<() => Response>) {
  const fn = vi.fn();
  for (const r of responses) fn.mockImplementationOnce(async () => r());
  vi.stubGlobal("fetch", fn);
  return fn;
}
const ok = (data: HistoryEntry[]) => () => new Response(JSON.stringify({ data }), { status: 200 });

describe("booking history", () => {
  it("loads only when opened and shows who and when", async () => {
    const fetchMock = stubFetch(ok(entries));
    render(<BookingHistory appointmentId="a1" />);
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /History/ }));
    expect(await screen.findByText("Changed practitioner")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/staff/appointments/a1/history");
    expect(screen.getByText("Dr Rao → Dr Shah")).toBeInTheDocument();
    expect(screen.getByText(/by Priya \(staff\)/)).toBeInTheDocument();
    expect(screen.getByText(/by the customer/)).toBeInTheDocument();
    expect(screen.getByText(/automatically/)).toBeInTheDocument();
    expect(screen.getAllByText(/Nov/).length).toBe(3);
  });

  it("shows the empty state", async () => {
    stubFetch(ok([]));
    render(<BookingHistory appointmentId="a1" />);
    await userEvent.click(screen.getByRole("button", { name: /History/ }));
    expect(await screen.findByText("Nothing has happened yet")).toBeInTheDocument();
  });

  it("offers Retry after an error", async () => {
    const fetchMock = stubFetch(() => new Response("{}", { status: 500 }), ok(entries));
    render(<BookingHistory appointmentId="a1" />);
    await userEvent.click(screen.getByRole("button", { name: /History/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Booked")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
