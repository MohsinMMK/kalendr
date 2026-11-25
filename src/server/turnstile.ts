import "server-only";

import { auth, authIsConfigured } from "@/lib/auth";
import { turnstileField, turnstileTokenHeader } from "@/lib/bot-check";
import { ApiError } from "@/server/api-error";
import { env } from "@/server/env";
import { logger } from "@/server/logger";
import { getPatientAccount } from "@/server/patient-auth";
import type { RateLimitResult } from "@/server/rate-limit";
import { recordRefusal } from "@/server/rate-limit";

/**
 * Cloudflare Turnstile, the bot check on registration, customer code requests and public
 * booking. It is asked for only when a request looks risky (a second attempt from the same
 * network, from someone with no signed-in session), so most people never see it.
 *
 * Off when TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are unset; the request limits still apply.
 * Checking a token is the one outside call allowed inside a request: there is no other way to
 * know whether the person passed.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The public site key for the widget, or null when the bot check is off. */
export function turnstileSiteKey(): string | null {
  const { TURNSTILE_SITE_KEY: siteKey, TURNSTILE_SECRET_KEY: secret } = env();
  return siteKey && secret ? siteKey : null;
}

export interface TurnstileVerdict {
  readonly success: boolean;
  /** Cloudflare's error codes, such as "invalid-input-response" or "timeout-or-duplicate". */
  readonly errorCodes: readonly string[];
}

/** Asks Cloudflare whether a widget token is genuine. Never throws; a network failure is a failed check. */
export async function verifyTurnstileToken(
  token: string,
  options: { secret: string; remoteIp?: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<TurnstileVerdict> {
  if (!token || token.length > 2048) return { success: false, errorCodes: ["invalid-input-response"] };
  const body = new URLSearchParams({ secret: options.secret, response: token });
  if (options.remoteIp && options.remoteIp !== "unknown" && !options.remoteIp.includes("/")) body.set("remoteip", options.remoteIp);
  try {
    const response = await (options.fetchImpl ?? fetch)(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!response.ok) return { success: false, errorCodes: [`http-${response.status}`] };
    const result = (await response.json()) as { success?: unknown; "error-codes"?: unknown };
    const errorCodes = Array.isArray(result["error-codes"])
      ? result["error-codes"].filter((code): code is string => typeof code === "string")
      : [];
    return { success: result.success === true, errorCodes };
  } catch (error: unknown) {
    logger().warn({ event: "turnstile.unreachable", error: error instanceof Error ? error.name : "unknown" }, "bot check unavailable");
    return { success: false, errorCodes: ["internal-error"] };
  }
}

/** Someone already signed in, as a customer or as staff, has proven more than a bot check would. */
async function hasSignedInSession(headers: Headers): Promise<boolean> {
  const cookies = headers.get("cookie") ?? "";
  if (!cookies) return false;
  try {
    if (/(^|;\s*)(__Host-)?kalendr_patient=/.test(cookies) && (await getPatientAccount(headers))) return true;
    if (authIsConfigured && /kalendr\.session_token=/.test(cookies) && (await auth.api.getSession({ headers }))) return true;
  } catch {
    // A session that can't be read counts as no session; the check only adds a challenge.
  }
  return false;
}

/**
 * Asks for the bot check when this request is risky: the limit counter shows this network has
 * already tried at least once in the window, and the person is not signed in. Throws a 400 with
 * a field error when the token is missing or fails. Does nothing when Turnstile is not configured.
 */
export async function requireHumanWhenRisky(
  request: Request,
  attempt: Pick<RateLimitResult, "count">,
  remoteIp: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const { TURNSTILE_SITE_KEY: siteKey, TURNSTILE_SECRET_KEY: secret } = env();
  if (!siteKey || !secret) return;
  if (attempt.count < 2) return;
  if (await hasSignedInSession(request.headers)) return;

  const token = request.headers.get(turnstileTokenHeader)?.trim() ?? "";
  if (!token) {
    throw new ApiError(400, "challenge_required", "Confirm you are a person to continue.", {
      [turnstileField]: ["Complete the check to continue."],
    });
  }
  const verdict = await verifyTurnstileToken(token, { secret, remoteIp, fetchImpl });
  if (!verdict.success) {
    recordRefusal("bot_check.turnstile");
    throw new ApiError(400, "challenge_failed", "The check did not pass. Try it again.", {
      [turnstileField]: ["The check did not pass. Try it again."],
    });
  }
}
