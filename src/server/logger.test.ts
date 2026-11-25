import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "./logger";
import { inspect } from "node:util";

import { DrizzleQueryError } from "drizzle-orm/errors";

import { redact, redactError, redactText } from "@/lib/redact";
import { scrubEvent } from "@/lib/sentry-scrub";
import { redactConsole } from "./monitoring";
import { withRequestContext } from "./request-context";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      done();
    },
  });
  return { lines, log: createLogger({ destination, level: "info" }) };
}

describe("logger redaction", () => {
  it("redacts a phone number inside a log message", () => {
    const { lines, log } = capture();
    log.info("Reminder failed for +91 98765 43210 after retry");
    expect(lines[0].msg).toBe("Reminder failed for [redacted] after retry");
    expect(JSON.stringify(lines)).not.toContain("98765");
  });

  it("redacts phone, email, name, token, code and body fields", () => {
    const { lines, log } = capture();
    log.info(
      {
        phone: "+1 (415) 555-0134",
        customerEmail: "asha@example.com",
        name: "Asha Rao",
        manageToken: "tok_abc",
        code: "482913",
        body: { text: "My knee hurts" },
        templateKey: "booking_confirmation",
        errorName: "PostgresError",
      },
      "notification captured",
    );
    const line = lines[0];
    for (const field of ["phone", "customerEmail", "name", "manageToken", "code", "body"]) {
      expect(line[field]).toBe("[redacted]");
    }
    expect(line.templateKey).toBe("booking_confirmation");
    expect(line.errorName).toBe("PostgresError");
    const text = JSON.stringify(line);
    for (const leaked of ["0134", "asha@", "Asha Rao", "tok_abc", "482913", "knee"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("scrubs contact details hidden in nested strings and error messages", () => {
    const { lines, log } = capture();
    const error = new Error('duplicate key value (phone)=(+919876543210) for asha@example.com');
    log.error({ err: error, detail: { url: "/manage/abcDEF123?x=1" } }, "write failed");
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain("9876543210");
    expect(text).not.toContain("asha@example.com");
    expect(text).toContain("/manage/[token]");
  });

  it("carries the request id, tenant id and route from the request context", () => {
    const { lines, log } = capture();
    withRequestContext({ requestId: "req-1", route: "POST /api/appointments" }, () => {
      withRequestContext({ tenantId: "11111111-1111-4111-8111-111111111111" }, () => log.info("booked"));
    });
    expect(lines[0]).toMatchObject({
      requestId: "req-1",
      tenantId: "11111111-1111-4111-8111-111111111111",
      route: "POST /api/appointments",
      service: "kalendr-web",
      level: "info",
    });
  });

  it("keeps the error digest the error screen shows, but still scrubs anything else that looks like a phone", () => {
    const { lines, log } = capture();
    log.error({ errorDigest: "1195905211", attempt: "1195905211" }, "request failed");
    expect(lines[0].errorDigest).toBe("1195905211");
    expect(lines[0].attempt).toBe("[redacted]");
    expect(redact({ errorDigest: "call +91 98450 12345" })).toEqual({ errorDigest: "call [redacted]" });
  });

  it("leaves identifiers, dates and times alone", () => {
    const id = "0b9f3c2e-1d4a-4c5b-9e8f-123456789012";
    expect(redactText(`appointment ${id} on 2026-11-12 at 2026-11-12T09:30:00Z`)).toBe(
      `appointment ${id} on 2026-11-12 at 2026-11-12T09:30:00Z`,
    );
    expect(redact({ attempt: 3, at: "2026-11-12" })).toEqual({ attempt: 3, at: "2026-11-12" });
  });

  it("removes credentials from connection strings", () => {
    expect(redactText("connect postgresql://app:hunter2@db:5432/kalendr failed")).toBe(
      "connect postgresql://[redacted]@db:5432/kalendr failed",
    );
  });

  it("drops the values of a failed database query from messages, stacks and error reports", () => {
    const error = new DrizzleQueryError(
      "insert into customers (first_name, phone) values ($1, $2)",
      ["Asha", "+91 98450 12345"],
      Object.assign(new Error('password authentication failed for user "kalendr_app"'), { code: "28P01" }),
    );
    expect(redactText(error.message)).toBe("Failed query: insert into customers (first_name, phone) values ($1, $2)\nparams: [redacted]");
    expect(redactText(error.stack ?? "")).toMatch(/params: \[redacted\]\n {4}at /);

    const printed = inspect(redactError(error));
    expect(printed).not.toContain("Asha");
    expect(printed).not.toContain("98450");
    expect(printed).toContain("28P01");
    expect(printed).toContain("password authentication failed");

    const event = scrubEvent({ type: undefined, exception: { values: [{ type: "Error", value: error.message }] } });
    expect(JSON.stringify(event)).not.toContain("Asha");
  });

  it("redacts what Next.js prints with console.error", () => {
    const printed: unknown[][] = [];
    const target = { error: (...args: unknown[]) => void printed.push(args), warn: (...args: unknown[]) => void printed.push(args) };
    redactConsole(target);
    redactConsole(target); // a second call does not wrap twice
    target.error("⨯", new DrizzleQueryError("select * from customers where email = $1", ["asha@example.com"]));
    target.warn("call +91 98450 12345", { phone: "+91 98450 12345", route: "GET /book/[clinicSlug]" });
    const text = inspect(printed, { depth: 6 });
    expect(printed).toHaveLength(2);
    expect(text).not.toContain("asha@example.com");
    expect(text).not.toContain("98450");
    expect(text).toContain("GET /book/[clinicSlug]");
  });
});
