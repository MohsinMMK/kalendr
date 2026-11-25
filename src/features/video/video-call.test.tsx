/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VisitEnterView } from "@/lib/video-contracts";

const frame = {
  on: vi.fn(),
  join: vi.fn(async () => undefined),
  destroy: vi.fn(async () => undefined),
};
const createFrame = vi.fn(() => frame);
vi.mock("@daily-co/daily-js", () => ({ default: { createFrame } }));

import { VideoCall } from "./video-call";

const daily: VisitEnterView = { provider: "daily", roomUrl: "https://example.daily.co/room", meetingToken: "tok", expiresAt: "2030-01-01T11:00:00.000Z", displayName: "Priya" };

beforeEach(() => {
  frame.on.mockClear();
  frame.join.mockClear();
  frame.destroy.mockClear();
  createFrame.mockClear();
});

afterEach(() => cleanup());

describe("video call", () => {
  it("joins the Daily room with the meeting token and cleans up", async () => {
    const { unmount } = render(<VideoCall enter={daily} onLeave={() => undefined} />);
    await waitFor(() => expect(frame.join).toHaveBeenCalledWith({ url: "https://example.daily.co/room", token: "tok" }));
    unmount();
    expect(frame.destroy).toHaveBeenCalled();
  });

  it("offers Try again and the phone number when joining fails", async () => {
    frame.join.mockRejectedValueOnce(new Error("nope"));
    render(<VideoCall enter={daily} onLeave={() => undefined} businessPhone="+91 98450 12345" />);
    expect(await screen.findByText("The call could not connect")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /98450 12345/ })).toHaveAttribute("href", "tel:+919845012345");
  });

  it("in test mode shows your own camera, muted, with a notice and never calls Daily", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });
    render(<VideoCall enter={{ ...daily, provider: "test", roomUrl: "kalendr-test-room://x" }} onLeave={() => undefined} />);
    expect(screen.getByText(/Test mode: nobody else can join. Connect a video account to talk to others./)).toBeInTheDocument();
    const video = await screen.findByLabelText("Your camera");
    expect((video as HTMLVideoElement).muted).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(createFrame).not.toHaveBeenCalled();
  });
});
