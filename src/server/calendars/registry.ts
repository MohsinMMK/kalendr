/**
 * Maps a provider id to its adapter. Everything that touches the outside world is
 * injectable, so the worker's tests build a registry with the fake and no network.
 */
import { createCalDavProvider } from "./caldav";
import type { CalDavApiFactory } from "./caldav-api";
import { calendarConfigFromEnv, isProviderConfigured, type CalendarConfig } from "./config";
import { CalendarProviderError } from "./errors";
import { createGoogleProvider } from "./google";
import type { GoogleTransport } from "./google-transport";
import type { HttpTransport } from "./http";
import { createMicrosoftProvider } from "./microsoft";
import type { CalendarProvider, ProviderId, RefreshedTokens } from "./provider";

export interface CalendarProviderDeps {
  /** Defaults to the process environment. */
  config?: CalendarConfig;
  /** Called whenever an access token was refreshed; persist the new tokens (encrypted). */
  onCredentialsRefreshed?: (tokens: RefreshedTokens) => void | Promise<void>;
  now?: () => Date;
  /** Network seams. */
  googleTransport?: GoogleTransport;
  microsoftTransport?: HttpTransport;
  caldavApiFactory?: CalDavApiFactory;
  /** Replaces an adapter outright, e.g. with `FakeCalendarProvider`. */
  overrides?: Partial<Record<ProviderId, CalendarProvider>>;
}

export const PROVIDER_IDS: readonly ProviderId[] = ["google", "microsoft", "apple"];

export function createCalendarProvider(id: ProviderId, deps: CalendarProviderDeps = {}): CalendarProvider {
  const override = deps.overrides?.[id];
  if (override) return override;
  const config = deps.config ?? calendarConfigFromEnv();
  if (id === "google") {
    if (!config.google) throw new CalendarProviderError("not_configured", "Google Calendar is not configured");
    return createGoogleProvider({ app: config.google, transport: deps.googleTransport, onCredentialsRefreshed: deps.onCredentialsRefreshed, now: deps.now });
  }
  if (id === "microsoft") {
    if (!config.microsoft) throw new CalendarProviderError("not_configured", "Outlook calendar is not configured");
    return createMicrosoftProvider({ app: config.microsoft, transport: deps.microsoftTransport, onCredentialsRefreshed: deps.onCredentialsRefreshed, now: deps.now });
  }
  return createCalDavProvider({ apiFactory: deps.caldavApiFactory, now: deps.now });
}

/** Which providers a business can offer right now (for the "Connect" buttons). */
export function configuredProviders(deps: Pick<CalendarProviderDeps, "config" | "overrides"> = {}): ProviderId[] {
  const config = deps.config ?? calendarConfigFromEnv();
  return PROVIDER_IDS.filter((id) => deps.overrides?.[id] !== undefined || isProviderConfigured(config, id));
}
