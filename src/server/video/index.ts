/** Which video provider this process uses, from the environment. No "server-only": the worker uses it too. */
import { env, type EnvironmentSource } from "../env";
import { createDailyProvider } from "./daily";
import { createFakeVideoProvider } from "./fake";
import type { VideoProvider } from "./provider";

export type VideoMode = "daily" | "test" | "off";

/** `daily` when keys are set, `off` when turned off, otherwise local test mode (never in production: env refuses). */
export function videoMode(source: EnvironmentSource = process.env): VideoMode {
  const value = env(source);
  if (value.VIDEO_PROVIDER === "none") return "off";
  if (value.VIDEO_PROVIDER === "test") return "test";
  if (value.VIDEO_PROVIDER === "daily" && value.DAILY_API_KEY && value.DAILY_DOMAIN) return "daily";
  return value.NODE_ENV === "production" ? "off" : "test";
}

let shared: { mode: VideoMode; provider: VideoProvider } | undefined;

/** One provider per process, so test mode's in-memory rooms are shared by the routes that use them. */
export function getVideoProvider(source: EnvironmentSource = process.env): VideoProvider | null {
  const mode = videoMode(source);
  if (mode === "off") return null;
  if (shared?.mode === mode) return shared.provider;
  const value = env(source);
  const provider = mode === "daily"
    ? createDailyProvider({ apiKey: value.DAILY_API_KEY ?? "", domain: value.DAILY_DOMAIN ?? "" })
    : createFakeVideoProvider();
  shared = { mode, provider };
  return provider;
}

export { createFakeVideoProvider } from "./fake";
