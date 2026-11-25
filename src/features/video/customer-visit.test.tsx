/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VisitEnterView, VisitStatusView } from "@/lib/video-contracts";

import { CustomerVisit } from "./customer-visit";

const base: VisitStatusView = {
  state: "open",
  startsAt: "2030-01-01T10:00:00.000Z",
  endsAt: "2030-01-01T10:30:00.000Z",
  opensAt: "2030-01-01T09:45:00.000Z",
  closesAt: "2030-01-01T11:00:00.000Z",
  businessName: "Rao Clinic",
  businessPhone: "+91 98450 12345",
  serviceName: "Follow-up",
  staffName: "Dr Rao",
  customerFirstName: "Priya",
  staffPresent: false,
  customerStage: "none",
  provider: "test",
};
const enterView: VisitEnterView = { provider: "test", roomUrl: "kalendr-test-room://abc", meetingToken: "t", expiresAt: "2030-01-01T11:00:00.000Z", displayName: "Priya" };

interface Call { url: string; method: string; body: { action?: string } | undefined }
let calls: Call[];
let current: VisitStatusView;
let enterResult: { status: number; body: unknown };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  calls = [];
  current = { ...base };
  enterResult = { status: 200, body: { data: enterView } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.method === "POST" && call.body?.action === "wait") {
      current = { ...current, customerStage: "waiting" };
    }
    if (call.method === "POST" && call.body?.action === "enter") {
      return { ok: enterResult.status < 400, status: enterResult.status, json: async () => enterResult.body } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ data: current }) } as Response;
  }));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup() {
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("customer video visit", () => {
  it("shows when it opens, with a countdown and the phone fallback", async () => {
    current = { ...base, state: "not_open_yet" };
    render(<CustomerVisit token="tok" />);
    expect(await screen.findByRole("heading", { level: 1, name: /^Opens at / })).toBeInTheDocument();
    expect(screen.getByText(/That is in/)).toBeInTheDocument();
    expect(screen.getByText("If the call won't work, phone us instead.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /98450 12345/ })).toHaveAttribute("href", "tel:+919845012345");
  });

  it("says the room is being made", async () => {
    current = { ...base, state: "preparing" };
    render(<CustomerVisit token="tok" />);
    expect(await screen.findByRole("heading", { name: "Getting the room ready…" })).toBeInTheDocument();
  });

  it.each([
    ["not_video", "This visit is not a video call"],
    ["cancelled", "This visit was cancelled"],
    ["ended", "This visit has ended"],
  ] as const)("explains plainly when the visit is %s", async (state, title) => {
    current = { ...base, state };
    render(<CustomerVisit token="tok" />);
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /98450 12345/ })).toBeInTheDocument();
  });

  it("goes from the device check to the waiting room to the call", async () => {
    const user = setup();
    render(<CustomerVisit token="tok" />);
    await user.click(await screen.findByRole("button", { name: /I'm ready/ }));
    expect(await screen.findByText("Dr Rao has not joined yet.")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST" && call.body?.action === "wait")).toBe(true);

    current = { ...current, staffPresent: true };
    await tick(5_000);
    expect(await screen.findByText("Dr Rao is here and will let you in shortly.")).toBeInTheDocument();

    // Not asked to enter until staff admit them.
    expect(calls.some((call) => call.body?.action === "enter")).toBe(false);
    current = { ...current, customerStage: "admitted" };
    await tick(5_000);
    expect(await screen.findByTestId("video-call")).toBeInTheDocument();
    expect(calls.filter((call) => call.body?.action === "enter")).toHaveLength(1);
    expect(screen.getByText(/Test mode: nobody else can join/)).toBeInTheDocument();
  });

  it("sends a heartbeat every 20 seconds while waiting", async () => {
    const user = setup();
    render(<CustomerVisit token="tok" />);
    await user.click(await screen.findByRole("button", { name: /I'm ready/ }));
    await screen.findByText("Dr Rao has not joined yet.");
    await tick(20_000);
    await waitFor(() => expect(calls.filter((call) => call.body?.action === "heartbeat").length).toBeGreaterThanOrEqual(1));
  });

  it("lets them continue even when they say no to the camera", async () => {
    const user = setup();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new DOMException("no", "NotAllowedError"); }) },
    });
    render(<CustomerVisit token="tok" />);
    await user.click(await screen.findByRole("button", { name: "Turn on camera and microphone" }));
    expect(await screen.findByText(/We can.t use your camera or microphone/)).toBeInTheDocument();
    const ready = screen.getByRole("button", { name: /I'm ready/ });
    expect(ready).toBeEnabled();
    await user.click(ready);
    expect(await screen.findByText("Dr Rao has not joined yet.")).toBeInTheDocument();
  });

  it("shows only the device check with ?test=1 and never joins", async () => {
    render(<CustomerVisit token="tok" testOnly />);
    expect(screen.getByRole("heading", { name: "Test your camera" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play a test sound" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /I'm ready/ })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("shows an error with a way to retry when the visit cannot load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    render(<CustomerVisit token="tok" />);
    expect(await screen.findByText(/could not reach the server/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
