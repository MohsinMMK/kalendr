import "server-only";

import { calendarProviderSchema, type AppleConnectInput, type CalendarProviderName } from "@/lib/calendar-sync";
import { isOAuthProvider, type OAuthCalendarProvider } from "@/server/calendars";
import { calendarMode, calendarProvider, providerStates } from "@/server/calendars/runtime";

import { ApiError } from "./api-error";
import { createOAuthState, verifyOAuthState } from "./calendar-oauth-state";
import { appleCredentials, requireOwnCalendars, saveConnection } from "./calendar-sync";
import { requireFeature } from "./entitlements";
import { appOrigin, env } from "./env";
import type { StaffContext } from "./staff-context";

export const oauthProviderSchema = calendarProviderSchema.exclude(["apple"]);

/** Connecting a calendar is a paid feature (Free has no calendar sync); the plan is checked before anything is saved. */
function requireCalendarSync(context: StaffContext): string {
  requireFeature(context, "calendarSync");
  return requireOwnCalendars(context);
}

function authSecret(): string {
  const secret = env().BETTER_AUTH_SECRET;
  if (!secret) throw new ApiError(503, "auth_unavailable", "Calendar sign-in is not configured.");
  return secret;
}

function redirectUriFor(provider: CalendarProviderName): string {
  return `${appOrigin()}/api/staff/calendars/callback/${provider}`;
}

function oauthAdapter(provider: CalendarProviderName): OAuthCalendarProvider {
  const adapter = calendarProvider(provider);
  if (!isOAuthProvider(adapter)) throw new ApiError(400, "not_oauth", "This calendar connects with a password, not a sign-in page.");
  return adapter;
}

/** Where to send the person to sign in, and the cookie value that ties the answer to this browser. No outside call. */
export function beginConnect(context: StaffContext, provider: Exclude<CalendarProviderName, "apple">): { redirectTo: string; nonce: string } {
  const membershipId = requireCalendarSync(context);
  const state = providerStates().find((item) => item.provider === provider);
  if (!state?.available) throw new ApiError(409, "provider_unavailable", state?.reason ?? "This calendar is not available.");
  const { state: signed, nonce } = createOAuthState(authSecret(), { tenantId: context.tenantId, membershipId, provider });
  if (calendarMode() === "fake") {
    // Test accounts: skip the provider and go straight to our own callback with the fake's good code.
    const url = new URL(redirectUriFor(provider));
    url.search = new URLSearchParams({ code: "good-code", state: signed }).toString();
    return { redirectTo: url.toString(), nonce };
  }
  return { redirectTo: oauthAdapter(provider).buildAuthUrl(signed, redirectUriFor(provider)), nonce };
}

/**
 * The provider's redirect back. The state must match the cookie and the person signed in now. The code
 * exchange is the one outside call a request makes here: the provider has to answer before the person can
 * continue. Everything after it (checking the account, listing calendars) is done by the worker.
 */
export async function finishConnect(
  context: StaffContext,
  provider: Exclude<CalendarProviderName, "apple">,
  input: { code: string | null; state: string | null; cookieNonce: string | null },
): Promise<{ connectionId: string }> {
  const membershipId = requireCalendarSync(context);
  const checked = verifyOAuthState(authSecret(), input.state, input.cookieNonce, { tenantId: context.tenantId, membershipId, provider });
  if (!checked.ok) throw new ApiError(400, "invalid_state", "That sign-in link has expired or was not started here. Try connecting again.");
  if (!input.code) throw new ApiError(400, "no_code", "The calendar did not send back a sign-in code. Try connecting again.");
  let exchanged;
  try {
    exchanged = await oauthAdapter(provider).exchangeCode(input.code, redirectUriFor(provider));
  } catch {
    throw new ApiError(502, "provider_refused", "The calendar did not accept the sign-in. Try connecting again.");
  }
  return saveConnection(context, membershipId, provider, exchanged.accountEmail, {
    kind: "oauth", provider, refreshToken: exchanged.refreshToken, accessToken: exchanged.accessToken, expiresAt: exchanged.expiresAt,
  });
}

/** Saves an Apple login as pending; the worker checks it and lists the calendars. The screen waits for it. */
export async function connectApple(context: StaffContext, input: AppleConnectInput): Promise<{ connectionId: string }> {
  const membershipId = requireCalendarSync(context);
  const state = providerStates().find((item) => item.provider === "apple");
  if (!state?.available) throw new ApiError(409, "provider_unavailable", state?.reason ?? "This calendar is not available.");
  return saveConnection(context, membershipId, "apple", input.appleId.toLowerCase(), appleCredentials(input));
}
