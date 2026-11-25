import { createHash } from "node:crypto";

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";

/** Turns what staff or a customer typed into E.164, or null when it is not a real number. */
export function toE164(input: string, defaultCountry: string = "IN"): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, trimmed.startsWith("+") ? undefined : (defaultCountry as CountryCode));
  return parsed?.isValid() ? parsed.number : null;
}

/** A salted hash of a number, for finding a thread from an incoming message without keeping a second copy of the number. */
export function contactHash(channel: "sms" | "whatsapp", e164: string): string {
  return createHash("sha256").update(`kalendr-contact:${channel}:${e164}`).digest("hex");
}
