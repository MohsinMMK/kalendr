/** @vitest-environment node */

import { beforeEach, describe, expect, it, vi } from "vitest";

const served = vi.hoisted(() => vi.fn<(host: string) => Promise<boolean>>());
vi.mock("@/server/domains/service", () => ({ isServedDomain: served }));
vi.mock("@/server/http", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/http")>()), enforceLimit: vi.fn(async () => ({ allowed: true })) }));

import { GET } from "./route";

const ask = (query: string) => GET(new Request(`https://app.kalendr.example/api/internal/domain-check${query}`));

describe("certificate check (feature 13)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    served.mockReset();
  });

  it("says yes only for a live address and gives no body", async () => {
    served.mockImplementation(async (host) => host === "book.acme.test");
    const yes = await ask("?domain=book.acme.test");
    expect(yes.status).toBe(200);
    expect(await yes.text()).toBe("");
    expect((await ask("?domain=random.example.org")).status).toBe(404);
    expect((await ask("")).status).toBe(404);
  });

  it("needs the shared token when one is set, compared exactly", async () => {
    vi.stubEnv("KALENDR_DOMAIN_CHECK_TOKEN", "s3cret-token");
    served.mockResolvedValue(true);
    expect((await ask("?domain=book.acme.test")).status).toBe(403);
    expect((await ask("?domain=book.acme.test&token=wrong")).status).toBe(403);
    expect((await ask("?domain=book.acme.test&token=s3cret-token")).status).toBe(200);
    expect(served).toHaveBeenCalledTimes(1);
  });
});
