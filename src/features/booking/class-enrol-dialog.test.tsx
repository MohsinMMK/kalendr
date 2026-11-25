/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TimetableSession } from "@/lib/classes-contracts";

import { ClassEnrolDialog } from "./class-enrol-dialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const session = (over: Partial<TimetableSession> = {}): TimetableSession => ({
  id: "s1", serviceId: "svc1", serviceName: "Morning yoga", locationId: "loc1", startsAt: "2026-12-01T04:30:00.000Z", endsAt: "2026-12-01T05:30:00.000Z",
  teacherName: "Asha Rao", capacity: 10, seatsLeft: 1, state: "open", priceMinor: null, currency: "INR", ...over,
});

function open(chosen: TimetableSession = session()) {
  const onChanged = vi.fn();
  render(<ClassEnrolDialog session={chosen} clinicSlug="lotus" businessName="Lotus Studio" locale="en-IN" zone="Asia/Kolkata" onClose={() => {}} onChanged={onChanged} />);
  return onChanged;
}

async function fill(user: ReturnType<typeof userEvent.setup>, { privacy = true } = {}) {
  await user.type(screen.getByLabelText("First name"), "Priya");
  await user.type(screen.getByLabelText("Last name"), "Shah");
  await user.type(screen.getByLabelText("Email address"), "priya@example.com");
  if (privacy) await user.click(screen.getByRole("checkbox", { name: /I understand and agree/ }));
}

const headerOf = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>;

describe("taking a seat in a class", () => {
  it("shows the class and time in the place's zone, and books", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => json({ data: { status: "booked", enrolmentId: "e1", manageToken: "seat-token-1" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const changed = open();
    expect(screen.getByText(/Morning yoga with Asha Rao, .* at 10:00 am\./)).toBeInTheDocument();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Book my seat" }));
    expect(await screen.findByText("You’re booked")).toBeInTheDocument();
    expect(screen.getByText("A confirmation is on its way.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See or cancel your place" })).toHaveAttribute("href", "/class/seat-token-1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/public/classes/s1/enrol");
    expect(JSON.parse(String(init.body))).toMatchObject({ clinicSlug: "lotus", firstName: "Priya", email: "priya@example.com", acceptedPrivacyNotice: true, joinWaitlist: false });
    expect(headerOf(fetchMock.mock.calls[0]!)["Idempotency-Key"]).toBeTruthy();
    expect(changed).toHaveBeenCalled();
  });

  it("asks to agree to the privacy notice before sending", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    open();
    await fill(user, { privacy: false });
    await user.click(screen.getByRole("button", { name: "Book my seat" }));
    expect(await screen.findByText("Agree to this use of your details to continue.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers the waiting list when the last seat just went, and posts again with a new key", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "class_full", message: "full", details: { waitlistOpen: true } } }, 409))
      .mockResolvedValueOnce(json({ data: { status: "waitlisted", enrolmentId: "e2", manageToken: "seat-token-2", position: 2 } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    open();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Book my seat" }));
    expect(await screen.findByText(/Someone just took the last seat/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Join the waiting list" }));
    expect(await screen.findByText("You’re number 2 on the waiting list")).toBeInTheDocument();
    expect(screen.getByText(/We’ll message you when a seat opens/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See or cancel your place" })).toHaveAttribute("href", "/class/seat-token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).joinWaitlist).toBe(false);
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)).joinWaitlist).toBe(true);
    expect(headerOf(fetchMock.mock.calls[1]!)["Idempotency-Key"]).not.toBe(headerOf(fetchMock.mock.calls[0]!)["Idempotency-Key"]);
  });

  it("opens a full class straight to the waiting list", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => json({ data: { status: "waitlisted", enrolmentId: "e3", manageToken: "t3", position: 1 } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    open(session({ state: "full", seatsLeft: 0 }));
    expect(screen.getByRole("heading", { name: "Join the waiting list" })).toBeInTheDocument();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Join the waiting list" }));
    expect(await screen.findByText("You’re number 1 on the waiting list")).toBeInTheDocument();
    expect(JSON.parse(String(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]).body)).joinWaitlist).toBe(true);
  });

  it("shows the server's field errors beside the field", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "validation_error", message: "Check the form.", fieldErrors: { email: ["That email address is not right."] } } }, 400)));
    open();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Book my seat" }));
    expect(await screen.findByText("That email address is not right.")).toBeInTheDocument();
    expect(screen.queryByText("Check the form.")).toBeNull();
  });

  it("keeps the same key when the same form is retried after a failure", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "internal_error", message: "Something broke." } }, 500))
      .mockResolvedValueOnce(json({ data: { status: "booked", enrolmentId: "e1", manageToken: "tk" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    open();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Book my seat" }));
    const alert = await screen.findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("You’re booked")).toBeInTheDocument();
    expect(headerOf(fetchMock.mock.calls[1]!)["Idempotency-Key"]).toBe(headerOf(fetchMock.mock.calls[0]!)["Idempotency-Key"]);
  });
});
