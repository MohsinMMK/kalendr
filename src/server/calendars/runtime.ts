/**
 * Which calendar adapters this process uses. Shared by the web app and the worker, so it imports
 * neither "server-only" nor the "@/" alias.
 *
 * `CALENDAR_PROVIDER_MODE=fake` swaps every provider for an in-memory one with two demo calendars,
 * so a screen or an end-to-end test can run without any outside account. It is refused unless the
 * app's own address is on this machine, so a production server can never use it by mistake.
 */
import { appOrigin, env, isLoopbackAddress } from "../env";
import { calendarConfigFromEnv, isProviderConfigured } from "./config";
import { createCalendarProvider } from "./registry";
import { FakeCalendarProvider } from "./fake";
import type { CalendarProvider, ProviderId, RefreshedTokens } from "./provider";
import { PROVIDER_IDS } from "./registry";

export type CalendarMode = "live" | "fake";

export function calendarMode(): CalendarMode {
  if (env().CALENDAR_PROVIDER_MODE !== "fake") return "live";
  if (!isLoopbackAddress(appOrigin())) {
    throw new Error("CALENDAR_PROVIDER_MODE=fake is only allowed when the app's own address is on this machine.");
  }
  return "fake";
}

const demoProviders = new Map<ProviderId, FakeCalendarProvider>();

/** The one fake per provider in this process. The worker and the web app each have their own, with the same two calendars. */
export function demoCalendarProvider(id: ProviderId): FakeCalendarProvider {
  let provider = demoProviders.get(id);
  if (!provider) {
    provider = new FakeCalendarProvider({ id, supportsPush: id !== "apple", accountEmail: `${id}.demo@example.test` });
    provider.addCalendar("personal", "Personal", { primary: true });
    provider.addCalendar("work", "Work");
    demoProviders.set(id, provider);
  }
  return provider;
}

/** The adapter for a provider. `onCredentialsRefreshed` receives new tokens the caller must save. */
export function calendarProvider(id: ProviderId, onCredentialsRefreshed?: (tokens: RefreshedTokens) => void | Promise<void>): CalendarProvider {
  if (calendarMode() === "fake") return demoCalendarProvider(id);
  return createCalendarProvider(id, { onCredentialsRefreshed });
}

export interface ProviderState {
  provider: ProviderId;
  available: boolean;
  reason: string | null;
}

/** For the connect buttons: which providers work right now, and a plain reason when one does not. */
export function providerStates(): ProviderState[] {
  const fake = calendarMode() === "fake";
  const config = calendarConfigFromEnv();
  return PROVIDER_IDS.map((provider) => {
    if (fake || isProviderConfigured(config, provider)) return { provider, available: true, reason: null };
    return {
      provider,
      available: false,
      reason: provider === "google"
        ? "Google Calendar has not been set up for this site yet. Ask whoever runs Kalendr to add the Google keys."
        : "Outlook has not been set up for this site yet. Ask whoever runs Kalendr to add the Microsoft keys.",
    };
  });
}

/** The address a provider calls when a calendar changes. Google requires https. */
export function webhookUrl(provider: "google" | "microsoft"): string {
  return `${appOrigin()}/api/webhooks/${provider === "google" ? "google-calendar" : "microsoft-graph"}`;
}

/** The shared secret providers echo back. In fake mode a fixed local value is used. */
export function webhookSecret(): string | null {
  if (calendarMode() === "fake") return "fake-calendar-webhook-token-local-only";
  return calendarConfigFromEnv().webhookToken;
}
