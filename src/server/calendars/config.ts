/**
 * Calendar app credentials from the environment. Empty keys switch a provider off
 * rather than failing at start-up (STANDARDS: a feature with empty keys stays off).
 */
import { z } from "zod";

import type { ProviderId } from "./provider";

const keyPair = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });
export type OAuthAppConfig = z.infer<typeof keyPair>;

export interface CalendarConfig {
  google: OAuthAppConfig | null;
  microsoft: OAuthAppConfig | null;
  /** Shared secret echoed by Google channels and Microsoft subscriptions (clientState). */
  webhookToken: string | null;
}

/**
 * GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET
 * MICROSOFT_CALENDAR_CLIENT_ID / MICROSOFT_CALENDAR_CLIENT_SECRET
 * CALENDAR_WEBHOOK_TOKEN
 */
export function calendarConfigFromEnv(env: Record<string, string | undefined> = process.env): CalendarConfig {
  const pair = (id: string | undefined, secret: string | undefined): OAuthAppConfig | null => {
    const parsed = keyPair.safeParse({ clientId: id?.trim(), clientSecret: secret?.trim() });
    return parsed.success ? parsed.data : null;
  };
  const token = env.CALENDAR_WEBHOOK_TOKEN?.trim();
  return {
    google: pair(env.GOOGLE_CALENDAR_CLIENT_ID, env.GOOGLE_CALENDAR_CLIENT_SECRET),
    microsoft: pair(env.MICROSOFT_CALENDAR_CLIENT_ID, env.MICROSOFT_CALENDAR_CLIENT_SECRET),
    webhookToken: token ? token : null,
  };
}

/** Apple needs no app registration, so it is always available. */
export function isProviderConfigured(config: CalendarConfig, provider: ProviderId): boolean {
  if (provider === "apple") return true;
  return config[provider] !== null;
}
