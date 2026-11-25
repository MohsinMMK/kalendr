/**
 * Structured JSON logs on stdout. Each line carries the request id, tenant id and
 * route from the active request context, and passes through `redact` first, so a
 * phone number, email, name, token, code or message body never reaches the output.
 *
 * No pino transports: they start worker threads that don't survive bundling. A log
 * shipper reads stdout.
 */
import pino, { type DestinationStream, type Logger } from "pino";

import { env } from "./env";
import { redact, redactText } from "../lib/redact";
import { currentRequestContext } from "./request-context";

export function createLogger(options: { destination?: DestinationStream; level?: string; service?: string } = {}): Logger {
  return pino(
    {
      level: options.level ?? env().LOG_LEVEL,
      base: { service: options.service ?? "kalendr-web" },
      messageKey: "msg",
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: () => ({ ...currentRequestContext() }),
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => redact(object),
      },
      hooks: {
        // Scrub the message text and any extra string arguments as well as the object.
        logMethod(args, method) {
          const cleaned = args.map((argument) => (typeof argument === "string" ? redactText(argument) : argument));
          return method.apply(this, cleaned as Parameters<typeof method>);
        },
      },
      serializers: {
        err: (error: unknown) => redact(error),
        error: (error: unknown) => redact(error),
      },
    },
    options.destination,
  );
}

interface LoggerGlobals {
  kalendrLogger?: Logger;
}

const loggerGlobals = globalThis as typeof globalThis & LoggerGlobals;

/** The shared process logger. */
export function logger(): Logger {
  loggerGlobals.kalendrLogger ??= createLogger();
  return loggerGlobals.kalendrLogger;
}

/** Error fields that are safe to log: a class name and a database error class, never the message. */
export function errorSummary(error: unknown): { errorName: string; databaseCode?: string } {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const code =
    error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  return { errorName, ...(code && /^[0-9A-Z]{5}$/.test(code) ? { databaseCode: code } : {}) };
}
