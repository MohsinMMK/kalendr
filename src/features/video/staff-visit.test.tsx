/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StaffVideoHostView, StaffVideoView, VisitEnterView } from "@/lib/video-contracts";

import { StaffVisit } from "./staff-visit";

const waitingView: StaffVideoView = {
  state: "open",
  startsAt: "2030-01-01T10:00:00.000Z",
  endsAt: "2030-01-01T10:30:00.000Z",
  opensAt: "2030-01-01T09:45:00.000Z",
  closesAt: "2030-01-01T11:00:00.000Z",
  provider: "test",
  customerFirstName: "Priya",
  customerStage: "waiting",
  customerPresent: true,
  staffPresent: false,
  businessPhone: "+91 98450 12345",
};
const enter: VisitEnterView = { provider: "test", roomUrl: "kalendr-test-room://abc", meetingToken: "host", expiresAt: "2030-01-01T11:00:00.000Z", displayName: "Dr Rao" };

interface Call { url: string; method: string; body: { action?: string; kind?: string } | undefined; headers: Record<string, string> }
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    let data: unknown = waitingView;
    if (call.body?.action === "admit") data = { ...waitingView, customerStage: "admitted" } satisfies StaffVideoView;
    if (call.body?.action === "host") data = { status: waitingView, enter } satisfies StaffVideoHostView;
    if (call.body?.kind === "call_us") data = { queued: true };
    return { ok: true, status: 200, json: async () => ({ data }) } as Response;
  }));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("staff video visit", () => {
  it("shows who is waiting and lets them in with one post", async () => {
    const user = userEvent.setup();
    render(<StaffVisit appointmentId="a1" />);
    expect(await screen.findByText("Priya is waiting")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Let them in" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.body?.action === "admit")).toBe(true));
    expect(calls.find((call) => call.body?.action === "admit")!.url).toBe("/api/staff/appointments/a1/video");
    expect(await screen.findByText("Let in")).toBeInTheDocument();
  });

  it("starts the call with a host post", async () => {
    const user = userEvent.setup();
    render(<StaffVisit appointmentId="a1" />);
    await user.click(await screen.findByRole("button", { name: "Start the call" }));
    expect(await screen.findByTestId("video-call")).toBeInTheDocument();
    expect(calls.some((call) => call.body?.action === "host")).toBe(true);
  });

  it("sends the call-us message from the more menu", async () => {
    const user = userEvent.setup();
    render(<StaffVisit appointmentId="a1" />);
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Ask them to phone us/ }));
    await waitFor(() => expect(calls.some((call) => call.body?.kind === "call_us")).toBe(true));
    const sent = calls.find((call) => call.body?.kind === "call_us")!;
    expect(sent.url).toBe("/api/staff/appointments/a1/messages");
    expect(sent.headers["Idempotency-Key"]).toBeTruthy();
  });

  it("shows an error with a way to retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    render(<StaffVisit appointmentId="a1" />);
    expect(await screen.findByText(/could not reach the server/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
