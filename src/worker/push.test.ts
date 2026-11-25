import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class WebPushError extends Error {
    constructor(message: string, readonly statusCode: number) { super(message); }
  }
  return { sendNotification: vi.fn(), setVapidDetails: vi.fn(), WebPushError };
});
vi.mock("web-push", () => mocks);

import { resultForStatus, webPushSender } from "./push";

const vapid = { publicKey: "P".repeat(87), privateKey: "K".repeat(43), subject: "mailto:ops@example.com" };
const subscription = { endpoint: "https://push.example.com/x", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };

afterEach(() => vi.clearAllMocks());

describe("web push sender", () => {
  it("reads the push service's answer: gone, try again, or never", () => {
    expect(resultForStatus(404)).toBe("gone");
    expect(resultForStatus(410)).toBe("gone");
    expect(resultForStatus(429)).toBe("retry");
    expect(resultForStatus(503)).toBe("retry");
    expect(resultForStatus(undefined)).toBe("retry");
    expect(resultForStatus(400)).toBe("failed");
    expect(resultForStatus(401)).toBe("failed");
  });

  it("sends the short message with the key pair on this call only", async () => {
    const send = mocks.sendNotification.mockResolvedValue({ statusCode: 201 });
    const setGlobal = mocks.setVapidDetails;
    expect(await webPushSender(vapid).send(subscription, { title: "New booking at 4:30 pm", link: "/schedule?open=a" })).toBe("sent");
    expect(setGlobal).not.toHaveBeenCalled();
    const [target, payload, options] = send.mock.calls[0]!;
    expect(target).toEqual(subscription);
    expect(JSON.parse(String(payload))).toEqual({ title: "New booking at 4:30 pm", link: "/schedule?open=a" });
    expect(options).toMatchObject({ vapidDetails: { subject: vapid.subject }, TTL: 86_400 });
  });

  it("reports an address the push service says is gone, and a down service as retry", async () => {
    const send = mocks.sendNotification;
    send.mockRejectedValueOnce(new mocks.WebPushError("Gone", 410));
    expect(await webPushSender(vapid).send(subscription, { title: "x" })).toBe("gone");
    send.mockRejectedValueOnce(new mocks.WebPushError("Unavailable", 503));
    expect(await webPushSender(vapid).send(subscription, { title: "x" })).toBe("retry");
    send.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await webPushSender(vapid).send(subscription, { title: "x" })).toBe("retry");
  });
});
