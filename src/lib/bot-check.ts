/**
 * Names shared by the browser and the server for the bot filters.
 *
 * The booking form adds two free filters: a text field hidden from people and from screen
 * readers (scripts that fill every field fill it), and how long the booking flow was open
 * before sending. Turnstile, the challenge shown only to risky requests, sends its token in
 * a header so request bodies and their idempotency hashes don't change.
 */
export const bookingBotFieldNames = {
  honeypot: "companyWebsite",
  fillMs: "fillMs",
} as const;

/** No person picks a service, a time and types their details faster than this. */
export const minimumBookingFillMs = 3_000;

export const turnstileTokenHeader = "x-turnstile-token";

/** The field a missing or failed Turnstile check is reported under. */
export const turnstileField = "turnstileToken";

/** Error codes the server returns when it wants the check, or the check failed. */
export const challengeErrorCodes: readonly string[] = ["challenge_required", "challenge_failed"];
