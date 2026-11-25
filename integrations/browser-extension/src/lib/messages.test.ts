import { describe, expect, it } from "vitest";

import { ApiFailure, SignedOutError, type KalendrClient } from "./client";
import { handle, requestSchema, toFailure } from "./messages";

const never = () => { throw new Error("not called"); };
const fake = (overrides: Partial<Record<keyof KalendrClient, unknown>>): KalendrClient => ({
  connected: never, pending: never, startConnect: never, pollConnect: never, cancelConnect: never, connectWithKey: never, disconnect: never, me: never, services: never, today: never, emailTimes: never, createLink: never,
  ...overrides,
}) as unknown as KalendrClient;

describe("the worker's messages", () => {
  it("accepts only the requests it knows, with safe ids", () => {
    expect(requestSchema.safeParse({ type: "services" }).success).toBe(true);
    expect(requestSchema.safeParse({ type: "createLink", serviceId: "svc_1", label: "Sam" }).success).toBe(true);
    expect(requestSchema.safeParse({ type: "createLink", serviceId: "../x" }).success).toBe(false);
    expect(requestSchema.safeParse({ type: "emailTimes" }).success).toBe(false);
    expect(requestSchema.safeParse({ type: "eval", code: "1" }).success).toBe(false);
    expect(requestSchema.safeParse("services").success).toBe(false);
  });

  it("turns answers and errors into plain values", async () => {
    const client = fake({ services: async () => [], today: async () => { throw new SignedOutError("revoked"); }, me: async () => { throw new ApiFailure("Busy.", 503, "unavailable"); }, emailTimes: async () => { throw new Error("secret detail"); } });
    expect(await handle({ type: "services" }, client)).toEqual({ ok: true, data: [] });
    expect(await handle({ type: "today" }, client)).toMatchObject({ ok: false, error: { kind: "signed_out" } });
    expect(await handle({ type: "me" }, client)).toEqual({ ok: false, error: { kind: "api", message: "Busy.", code: "unavailable", status: 503 } });
    const unexpected = await handle({ type: "emailTimes", serviceId: "s1" }, client);
    expect(JSON.stringify(unexpected)).not.toContain("secret detail");
    expect(toFailure(null).kind).toBe("unexpected");
  });

  it("reports whether it is connected and what code is waiting", async () => {
    const client = fake({ connected: async () => false, pending: async () => ({ userCode: "BCDF-GHJK", verificationUri: "https://k/x", expiresAt: 1, interval: 5 }) });
    expect(await handle({ type: "status" }, client)).toMatchObject({ ok: true, data: { connected: false, pending: { userCode: "BCDF-GHJK" } } });
  });
});
