/**
 * Removes personal data and secrets from anything about to leave the process:
 * log lines, error reports and trace attributes. It runs in Node, the edge runtime
 * and the browser, so it uses no Node APIs.
 *
 * Two layers:
 *  - Keys that name personal data or secrets have their whole value replaced.
 *  - Every remaining string is scanned for email addresses, phone numbers and
 *    manage-link tokens, which can turn up inside messages and URLs.
 */

const REDACTED = "[redacted]";

/** A key is sensitive when it ends with one of these words (case and separators ignored). */
const SENSITIVE_SUFFIXES = [
  "phone",
  "mobile",
  "email",
  "token",
  "secret",
  "password",
  "passcode",
  "otp",
  "cookie",
  "cookies",
  "authorization",
  "body",
  "content",
  "note",
  "notes",
  "address",
  "apikey",
  "dsn",
  "signature",
];

/** Keys that are sensitive only as a whole word ("name", not "templateName"). */
const SENSITIVE_KEYS = new Set([
  "name",
  "fullname",
  "firstname",
  "lastname",
  "displayname",
  "patientname",
  "customername",
  "clientname",
  "ownername",
  "code",
  "dob",
  "dateofbirth",
  "message",
  "text",
  "subject",
  "contact",
  "to",
  "from",
  "query",
  "querystring",
  "params",
  "parameters",
  "headers",
  "data",
]);

/** Keys we write ourselves that look sensitive but carry only identifiers or classes. */
const SAFE_KEYS = new Set(["errorcode", "databasecode", "templatekey", "errorname", "route"]);

/**
 * Keys whose value is an identifier Next.js computes, never something a person typed.
 * The error digest is a numeric hash that the error screen shows as "Reference", and
 * `reportRequestError` checks its shape before it reaches a log. The phone pattern would
 * hide a 10-digit digest, so these values skip the pattern scan when they look like one.
 */
const IDENTIFIER_KEYS = new Set(["errordigest"]);
const IDENTIFIER_VALUE = /^[A-Za-z0-9-]{1,64}$/;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SAFE_KEYS.has(normalized)) return false;
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// A run of 8+ digits with optional +, spaces, dots, dashes or brackets. The lookarounds
// stop it from eating part of a UUID or a longer word.
const PHONE_PATTERN = /(?<![\w.-])\+?\d[\d\s().-]{6,}\d(?![\w-])/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME_PREFIX = /^\d{4}-\d{2}-\d{2}[ T]\d{2}/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGE_LINK =/\/manage\/[^/?#\s"']+/g;
const RESET_LINK = /([?&](?:token|code|callbackURL)=)[^&#\s"']+/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const DSN_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
// Drizzle's query errors end their message with the bound values ("\nparams: Asha,+91…"),
// which can be any field a customer typed. Drop them up to the stack trace, if one follows.
const QUERY_PARAMS = /\nparams: [\s\S]*?(?=\n {4}at |$)/g;

/** Scrubs personal data that appears inside free text. */
export function redactText(value: string): string {
  return value
    .replace(QUERY_PARAMS, `\nparams: ${REDACTED}`)
    .replace(DSN_CREDENTIALS, `$1${REDACTED}@`)
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(MANAGE_LINK, "/manage/[token]")
    .replace(RESET_LINK, `$1${REDACTED}`)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(PHONE_PATTERN, (match) => {
      const digits = match.replace(/\D/g, "");
      if (digits.length < 8) return match;
      const trimmed = match.trim();
      if (ISO_DATE.test(trimmed) || ISO_TIME_PREFIX.test(trimmed) || UUID.test(trimmed)) return match;
      return REDACTED;
    });
}

/** Deep-copies `value`, replacing sensitive fields and scrubbing strings. Never mutates the input. */
export function redact<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return redactText(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return "[truncated]" as T;
  if (seen.has(value)) return "[circular]" as T;
  seen.add(value);

  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen)) as T;
  if (value instanceof Error) {
    // Postgres and driver messages can quote the failing row, so the text is scrubbed too.
    return {
      name: value.name,
      message: redactText(value.message),
      ...(value.stack ? { stack: redactText(value.stack) } : {}),
    } as T;
  }

  const output: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (IDENTIFIER_KEYS.has(normalizeKey(key)) && typeof field === "string" && IDENTIFIER_VALUE.test(field)) {
      output[key] = field;
      continue;
    }
    output[key] = isSensitiveKey(key) && field !== undefined && field !== null ? REDACTED : redact(field, depth + 1, seen);
  }
  return output as T;
}

/**
 * A copy of `error` that prints like the original (name, message, stack and its own fields,
 * such as a driver's `code` or a query error's `cause`) with personal data removed. For text
 * written outside the logger, such as Next.js printing an error a page threw.
 */
export function redactError(error: Error, depth = 0): Error {
  const copy = new Error(redactText(error.message));
  copy.name = error.name;
  copy.stack = error.stack ? redactText(error.stack) : undefined;
  for (const [key, field] of Object.entries(error)) {
    if (key === "cause") continue;
    // A database SQLSTATE ("28P01") or a Node error code ("ECONNREFUSED") says what failed, not who.
    if (key === "code" && typeof field === "string" && /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/.test(field)) {
      (copy as unknown as Record<string, unknown>)[key] = field;
      continue;
    }
    (copy as unknown as Record<string, unknown>)[key] = isSensitiveKey(key) && field !== undefined && field !== null ? REDACTED : redact(field, 1);
  }
  if (error.cause !== undefined) {
    copy.cause = error.cause instanceof Error && depth < 4 ? redactError(error.cause, depth + 1) : redact(error.cause, 1);
  }
  return copy;
}
