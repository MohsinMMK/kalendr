import { describe, expect, it } from "vitest";

import { safeReturnPath, testCheckoutEnabled } from "./test-checkout";

describe("test checkout availability", () => {
  it("is on outside production", () => {
    expect(testCheckoutEnabled({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("is off in production", () => {
    expect(testCheckoutEnabled({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "https://kalendr.example" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("is on for browser tests in production only on localhost", () => {
    const base = { NODE_ENV: "production", KALENDR_E2E_TEST_CHECKOUT: "true" } as const;
    expect(testCheckoutEnabled({ ...base, NEXT_PUBLIC_APP_URL: "http://localhost:3100" } as NodeJS.ProcessEnv)).toBe(true);
    expect(testCheckoutEnabled({ ...base, NEXT_PUBLIC_APP_URL: "https://kalendr.example" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("safeReturnPath", () => {
  it("keeps a manage page with its query", () => {
    expect(safeReturnPath("/manage/abc_DEF-123?paid=1")).toBe("/manage/abc_DEF-123?paid=1");
  });
  it.each(["https://evil.example/manage/x", "//evil.example/manage/x", "/dashboard", "/manage/../dashboard", "/manage//evil.example", "/manage/x\\y", "javascript:alert(1)", "", "/manage/\nx"])(
    "refuses %j",
    (value) => {
      expect(safeReturnPath(value)).toBeNull();
    },
  );
  it("refuses nothing at all", () => {
    expect(safeReturnPath(undefined)).toBeNull();
  });
});
