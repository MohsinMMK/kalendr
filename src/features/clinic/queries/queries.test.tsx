/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoAppointments } from "@/lib/demo-data";
import type { StaffAppointment, StaffSnapshot } from "@/lib/staff-snapshot";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { applyRescheduleToSnapshot, rescheduleBody, rescheduleFailure, useChangeAppointmentStatus, useRescheduleAppointment } from "./appointment-mutations";
import { StaffApiError } from "./http";
import { keysForLiveEvent, staffKeys } from "./keys";
import { usePatientSearch } from "./patient-search";

const first = demoAppointments[0];
const appointments: StaffAppointment[] = [{ ...first, version: 3 }, { ...demoAppointments[1], version: 1 }].map((appointment) => { const rest: Partial<typeof appointment> = { ...appointment }; delete rest.manageToken; return rest as StaffAppointment; });
const snapshot: StaffSnapshot = { ...staffSnapshotFixture, appointments };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(staffKeys.snapshot(), snapshot);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

function cached(client: QueryClient, id: string): StaffAppointment | undefined {
  return client.getQueryData<StaffSnapshot>(staffKeys.snapshot())?.appointments.find((item) => item.id === id);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("query keys", () => {
  it("starts every key with staff so one call can clear them all", () => {
    expect(staffKeys.snapshot()[0]).toBe("staff");
    expect(staffKeys.patientSearch("98")[0]).toBe("staff");
  });

  it("maps each kind of live event to the keys it makes stale", () => {
    expect(keysForLiveEvent("appointment")).toContainEqual(staffKeys.snapshot());
    expect(keysForLiveEvent("message")).toEqual([staffKeys.snapshot()]);
  });
});

describe("optimistic changes", () => {
  it("moves a visit and keeps its length, bumping the version the way the server does", () => {
    const length = Date.parse(first.endsAt) - Date.parse(first.startsAt);
    const next = applyRescheduleToSnapshot(snapshot, { kind: "move", appointmentId: first.id, startsAt: "2026-09-01T10:00:00+05:30", practitionerId: "practitioner_rohan", expectedVersion: 3, notifyCustomer: true });
    const moved = next.appointments[0];
    expect(moved.practitionerId).toBe("practitioner_rohan");
    expect(Date.parse(moved.startsAt)).toBe(Date.parse("2026-09-01T10:00:00+05:30"));
    expect(Date.parse(moved.endsAt) - Date.parse(moved.startsAt)).toBe(length);
    expect(moved.version).toBe(4);
    expect(next.appointments[1]).toBe(snapshot.appointments[1]);
  });

  it("changes only the end when a visit is resized", () => {
    const next = applyRescheduleToSnapshot(snapshot, { kind: "resize", appointmentId: first.id, endsAt: "2026-09-01T18:00:00+05:30", expectedVersion: 3, notifyCustomer: false });
    expect(next.appointments[0].startsAt).toBe(first.startsAt);
    expect(next.appointments[0].endsAt).toBe("2026-09-01T18:00:00+05:30");
  });

  it("builds the request body the reschedule route expects", () => {
    expect(rescheduleBody({ kind: "move", appointmentId: "a", startsAt: "2026-09-01T10:00:00+05:30", practitionerId: "p", expectedVersion: 2, notifyCustomer: false })).toEqual({
      action: "reschedule", startsAt: "2026-09-01T10:00:00+05:30", practitionerId: "p", expectedVersion: 2, notifyCustomer: false,
    });
    expect(rescheduleBody({ kind: "resize", appointmentId: "a", endsAt: "2026-09-01T10:30:00+05:30", expectedVersion: 2, notifyCustomer: true })).toMatchObject({ action: "resize" });
  });
});

describe("refused moves", () => {
  it("explains a clash in plain words", () => {
    const failure = rescheduleFailure(new StaffApiError("That time is no longer available.", 409, "slot_unavailable"));
    expect(failure.clash).toBe(true);
    expect(failure.title).toBe("That time is taken");
  });

  it("explains that someone else got there first", () => {
    expect(rescheduleFailure(new StaffApiError("stale", 409, "version_conflict")).description).toMatch(/Someone else changed it/);
  });

  it("never blames a dropped connection on a clash", () => {
    expect(rescheduleFailure(new TypeError("Failed to fetch")).clash).toBe(false);
  });
});

describe("rescheduling", () => {
  const request = { kind: "move" as const, appointmentId: first.id, startsAt: "2026-09-01T10:00:00+05:30", practitionerId: "practitioner_rohan", expectedVersion: 3, notifyCustomer: true };

  it("shows the move before the server answers, and keeps it when the server agrees", async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn((url: string) => url.includes("/api/staff/snapshot")
      ? Promise.resolve(new Response(JSON.stringify({ data: snapshot })))
      : new Promise<Response>((resolve) => { answer = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useRescheduleAppointment(), { wrapper });
    let done: Promise<unknown> = Promise.resolve();
    act(() => { done = result.current.mutateAsync(request); });
    await waitFor(() => expect(cached(client, first.id)?.practitionerId).toBe("practitioner_rohan"));
    expect(fetchMock).toHaveBeenCalledWith(`/api/staff/appointments/${first.id}`, expect.objectContaining({ method: "PATCH" }));
    await act(async () => { answer(new Response(JSON.stringify({ data: { appointmentId: first.id, status: "booked", version: 4 } }))); await done; });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("puts the card back when the server refuses, and leaves other cards alone", async () => {
    const other = demoAppointments[1].id;
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.includes("/api/staff/snapshot")
      ? new Response(JSON.stringify({ data: snapshot }))
      : new Response(JSON.stringify({ error: { code: "slot_unavailable", message: "That time is no longer available." } }), { status: 409 }))));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useRescheduleAppointment(), { wrapper });
    let refusal: unknown = null;
    await act(async () => { refusal = await result.current.mutateAsync(request).then(() => null, (error: unknown) => error); });
    expect(cached(client, first.id)?.practitionerId).toBe(first.practitionerId);
    expect(cached(client, first.id)?.version).toBe(3);
    expect(cached(client, other)?.version).toBe(1);
    expect(refusal).toBeInstanceOf(StaffApiError);
  });

  it("marks a cancelled visit at once and restores it if the status change is refused", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.includes("/api/staff/snapshot")
      ? new Response(JSON.stringify({ data: snapshot }))
      : new Response(JSON.stringify({ error: { code: "invalid_status_transition", message: "No." } }), { status: 409 }))));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useChangeAppointmentStatus(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ appointmentId: first.id, status: "cancelled", reason: "Doctor is unwell", expectedVersion: 3 }).catch(() => undefined); });
    expect(cached(client, first.id)?.status).toBe(first.status);
  });
});

describe("customer search", () => {
  it("waits for a pause in typing, then searches the server once", async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify({ data: { query: url, patients: [{ id: "p1", firstName: "Asha", lastName: "Rao", phone: "+91 98765 43210", email: "a@example.com" }], truncated: false } }))));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ query }) => usePatientSearch(query, true), { wrapper, initialProps: { query: "9" } });
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ query: "987" });
    rerender({ query: "98765" });
    expect(result.current.searching).toBe(true);
    await waitFor(() => expect(result.current.patients).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("q=98765");
  });

  it("does not search while the palette is closed", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = setup();
    const { result } = renderHook(() => usePatientSearch("98765", false), { wrapper });
    expect(result.current.patients).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
