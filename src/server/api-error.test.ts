import { describe, expect, it } from "vitest";

import { getPostgresErrorCode, mapDatabaseError } from "@/server/api-error";

describe("database error mapping", () => {
  it("maps a Drizzle wrapped exclusion failure to a slot conflict", () => {
    const error = new Error("query failed", {
      cause: { code: "23P01" },
    });
    expect(getPostgresErrorCode(error)).toBe("23P01");
    expect(mapDatabaseError(error)).toMatchObject({
      status: 409,
      code: "slot_unavailable",
    });
  });

  it("unwraps retryable errors without following a cyclic cause forever", () => {
    const error: { cause?: unknown } = {};
    error.cause = { code: "40001", cause: error };
    expect(getPostgresErrorCode(error)).toBe("40001");
    expect(mapDatabaseError(error)).toMatchObject({
      status: 503,
      code: "temporarily_unavailable",
    });
    expect(getPostgresErrorCode({ cause: error, code: "slot_unavailable" })).toBe("40001");
  });
});
