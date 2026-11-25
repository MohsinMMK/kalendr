import { describe, expect, it, vi } from "vitest";

import { createDailyProvider } from "./daily";
import { createFakeVideoProvider } from "./fake";
import { VideoPermanentError, VideoTransientError } from "./provider";
import { isPresent, roomExpiry, roomNameFor, visitState, visitWindow } from "./rules";
import { videoMode } from "./index";

const start = new Date("2026-11-23T05:30:00Z");
const end = new Date("2026-11-23T06:00:00Z");
const window = visitWindow(start, end);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("when a visit can be joined", () => {
  const state = (now: Date, overrides: Partial<Parameters<typeof visitState>[0]> = {}) =>
    visitState({ deliveryMode: "video", status: "booked", window, roomActive: true, now, ...overrides });

  it("opens 15 minutes before the start and closes 30 minutes after the end", () => {
    expect(window.opensAt.toISOString()).toBe("2026-11-23T05:15:00.000Z");
    expect(window.closesAt.toISOString()).toBe("2026-11-23T06:30:00.000Z");
    expect(state(new Date("2026-11-23T05:14:59Z"))).toBe("not_open_yet");
    expect(state(new Date("2026-11-23T05:15:00Z"))).toBe("open");
    expect(state(new Date("2026-11-23T06:29:59Z"))).toBe("open");
    expect(state(new Date("2026-11-23T06:30:00Z"))).toBe("ended");
  });

  it("is never open an hour after the visit", () => {
    expect(state(new Date("2026-11-23T07:00:00Z"))).toBe("ended");
  });

  it("says preparing until the room exists, and refuses cancelled and non-video visits", () => {
    expect(state(new Date("2026-11-23T05:20:00Z"), { roomActive: false })).toBe("preparing");
    expect(state(new Date("2026-11-23T05:20:00Z"), { status: "cancelled" })).toBe("cancelled");
    expect(state(new Date("2026-11-23T05:20:00Z"), { deliveryMode: "in_person" })).toBe("not_video");
  });

  it("names a room the same way every time, and differently for another booking or business", () => {
    expect(roomNameFor("t1", "a1")).toBe(roomNameFor("t1", "a1"));
    expect(roomNameFor("t1", "a1")).not.toBe(roomNameFor("t1", "a2"));
    expect(roomNameFor("t1", "a1")).not.toBe(roomNameFor("t2", "a1"));
    expect(roomNameFor("t1", "a1")).toMatch(/^v-[0-9a-f]{28}$/);
    expect(roomExpiry(end).toISOString()).toBe("2026-11-23T06:30:00.000Z");
  });

  it("counts someone as here for 45 seconds after their last heartbeat", () => {
    const seen = new Date("2026-11-23T05:20:00Z");
    expect(isPresent(seen, new Date("2026-11-23T05:20:45Z"))).toBe(true);
    expect(isPresent(seen, new Date("2026-11-23T05:20:46Z"))).toBe(false);
    expect(isPresent(null, seen)).toBe(false);
  });
});

describe("the Daily adapter", () => {
  const options = { apiKey: "test-key", domain: "riverbend" };

  it("makes a private room that expires, with no recording, and returns its address", async () => {
    const fetchFn = vi.fn(async () => json(200, { name: "v-1" }));
    const room = await createDailyProvider({ ...options, fetchFn }).createRoom({ name: "v-1", expiresAt: end });
    expect(room).toEqual({ name: "v-1", url: "https://riverbend.daily.co/v-1" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.daily.co/v1/rooms");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ name: "v-1", privacy: "private", properties: { exp: end.getTime() / 1000 } });
    expect(JSON.stringify(body)).not.toMatch(/record/i);
  });

  it("finds an existing room when a retry meets 'already exists', but not after any other bad request", async () => {
    const exists = vi.fn(async () => json(400, { error: "invalid-request-error", info: "a room named v-1 already exists" }));
    await expect(createDailyProvider({ ...options, fetchFn: exists }).createRoom({ name: "v-1", expiresAt: end })).resolves.toMatchObject({ name: "v-1" });
    const bad = vi.fn(async () => json(400, { error: "invalid-request-error", info: "bad property" }));
    await expect(createDailyProvider({ ...options, fetchFn: bad }).createRoom({ name: "v-1", expiresAt: end })).rejects.toBeInstanceOf(VideoPermanentError);
  });

  it("makes a token for one person, valid only in the window, with host rights only for owners", async () => {
    const fetchFn = vi.fn(async () => json(200, { token: "tok" }));
    const provider = createDailyProvider({ ...options, fetchFn });
    await expect(provider.createToken({ roomName: "v-1", isOwner: false, displayName: "Priya", notBefore: window.opensAt, expiresAt: window.closesAt })).resolves.toEqual({ token: "tok" });
    const body = JSON.parse(String(((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]).body));
    expect(body.properties).toMatchObject({ room_name: "v-1", is_owner: false, user_name: "Priya", nbf: window.opensAt.getTime() / 1000, exp: window.closesAt.getTime() / 1000, enable_screenshare: false });
  });

  it("tells a retry apart from a refusal", async () => {
    const make = (status: number) => createDailyProvider({ ...options, fetchFn: vi.fn(async () => json(status, {})) });
    await expect(make(503).createRoom({ name: "x", expiresAt: end })).rejects.toBeInstanceOf(VideoTransientError);
    await expect(make(429).createRoom({ name: "x", expiresAt: end })).rejects.toBeInstanceOf(VideoTransientError);
    await expect(make(401).createRoom({ name: "x", expiresAt: end })).rejects.toBeInstanceOf(VideoPermanentError);
    const offline = createDailyProvider({ ...options, fetchFn: vi.fn(async () => { throw new Error("offline"); }) });
    await expect(offline.createToken({ roomName: "x", isOwner: true, displayName: "a", notBefore: start, expiresAt: end })).rejects.toBeInstanceOf(VideoTransientError);
  });

  it("does not mind closing a room that is already gone", async () => {
    await expect(createDailyProvider({ ...options, fetchFn: vi.fn(async () => json(404, {})) }).deleteRoom("v-1")).resolves.toBeUndefined();
  });
});

describe("which provider runs", () => {
  it("uses Daily when keys are set, test mode when nothing is set, and nothing when turned off", () => {
    expect(videoMode({ VIDEO_PROVIDER: "daily", DAILY_API_KEY: "k", DAILY_DOMAIN: "d", NODE_ENV: "development" })).toBe("daily");
    expect(videoMode({ NODE_ENV: "development" })).toBe("test");
    expect(videoMode({ VIDEO_PROVIDER: "none", NODE_ENV: "development" })).toBe("off");
    expect(videoMode({ NODE_ENV: "production" })).toBe("off");
    expect(videoMode({ VIDEO_PROVIDER: "daily", NODE_ENV: "development" })).toBe("test");
  });

  it("the fake keeps what it was asked and never leaves the machine", async () => {
    const fake = createFakeVideoProvider();
    const room = await fake.createRoom({ name: "r", expiresAt: end });
    expect(room.url.startsWith("kalendr-test-room://")).toBe(true);
    const { token } = await fake.createToken({ roomName: "r", isOwner: true, displayName: "x", notBefore: start, expiresAt: end });
    expect(fake.tokens[0]?.token).toBe(token);
    await fake.deleteRoom("r");
    expect(fake.deleted).toEqual(["r"]);
  });
});
