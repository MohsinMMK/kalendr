import { beforeEach, describe, expect, it, vi } from "vitest";

const reportServerError = vi.fn();
vi.mock("./error-reporting", () => ({ reportServerError }));

const { reportRequestError } = await import("./monitoring");

describe("reportRequestError", () => {
  beforeEach(() => reportServerError.mockClear());

  it("reports the request id, the route pattern and the digest the error screen shows", () => {
    const error = Object.assign(new Error("render failed"), { digest: "1195905211" });
    reportRequestError(
      error,
      { method: "GET", headers: { "x-request-id": "req-12345678" } },
      { routePath: "/book/[clinicSlug]", routeType: "render" },
    );
    expect(reportServerError).toHaveBeenCalledWith(error, {
      requestId: "req-12345678",
      route: "GET /book/[clinicSlug]",
      errorDigest: "1195905211",
    });
  });

  it("makes up a request id when the header is missing or malformed, and drops an odd digest", () => {
    reportRequestError(
      Object.assign(new Error("x"), { digest: "not a digest <script>" }),
      { method: "POST", headers: { "x-request-id": "bad id" } },
      { routePath: "/manage/[token]", routeType: "action" },
    );
    const [, context] = reportServerError.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.route).toBe("POST /manage/[token]");
    expect(context.errorDigest).toBeUndefined();
  });
});
