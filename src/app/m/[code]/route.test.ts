/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveShortLinkToken = vi.fn();
const enforceLimit = vi.fn();
vi.mock("@/server/short-links", () => ({ resolveShortLinkToken: (code: string) => resolveShortLinkToken(code) }));
vi.mock("@/server/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/http")>()),
  enforceLimit: (...args: unknown[]) => enforceLimit(...args),
}));

import { ApiError } from "@/server/api-error";

import { GET } from "./route";

const get = (code: string) => GET(new Request(`http://127.0.0.1:3202/m/${code}`), { params: Promise.resolve({ code }) });

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_URL", "https://app.example.test");
  enforceLimit.mockResolvedValue({ allowed: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /m/[code]", () => {
  it("redirects to the manage page without caching or a referrer", async () => {
    resolveShortLinkToken.mockResolvedValue("tok_abc-123");
    const response = await get("aB3dE5gH7k");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.example.test/manage/tok_abc-123");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(enforceLimit).toHaveBeenCalledWith(expect.any(Request), "short_link.ip");
  });

  it("answers an unknown or expired code with a bare 404", async () => {
    resolveShortLinkToken.mockResolvedValue(null);
    const response = await get("zzzzzzzzzz");
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("This link is no longer available.");
  });

  it("refuses when the rate limit is passed, without looking the code up", async () => {
    enforceLimit.mockRejectedValue(new ApiError(429, "rate_limited", "Slow down.", undefined, { "Retry-After": "30" }));
    const response = await get("aB3dE5gH7k");
    expect(response.status).toBe(429);
    expect(resolveShortLinkToken).not.toHaveBeenCalled();
  });
});
