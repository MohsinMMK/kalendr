import { describe, expect, it, vi } from "vitest";

import { run } from "./cli.mjs";

function harness(env: Record<string, string>, reply: () => Response) {
  const out: string[] = [];
  const err: string[] = [];
  const fetch = vi.fn(async () => reply());
  return { out, err, fetch, io: { env, fetch: fetch as unknown as typeof globalThis.fetch, out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
}

const key = `kal_live_${"k".repeat(43)}`;

describe("kalendr cli", () => {
  it("calls the API with the key from the environment and prints JSON", async () => {
    const h = harness({ KALENDR_API_KEY: key, KALENDR_URL: "https://book.example.com/" }, () => Response.json({ data: [{ id: "svc_1" }], nextCursor: null }));
    expect(await run(["times", "--service", "svc_1", "--from", "2026-12-01T00:00:00Z"], h.io)).toBe(0);
    const [url, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://book.example.com/api/v1/availability?serviceId=svc_1&from=2026-12-01T00%3A00%3A00Z");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`);
    expect(JSON.parse(h.out.join("\n"))).toEqual({ data: [{ id: "svc_1" }], nextCursor: null });
  });

  it("sends writes with an idempotency key and never prints the API key", async () => {
    const h = harness({ KALENDR_API_KEY: key }, () => Response.json({ error: { code: "insufficient_scope", message: "This API key does not have the appointments:write scope." } }, { status: 403 }));
    expect(await run(["cancel", "appt_1", "--reason", "Customer called"], h.io)).toBe(1);
    const [url, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/v1/appointments/appt_1/cancel");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(init.body))).toEqual({ reason: "Customer called" });
    expect(h.err.join("\n")).toBe("insufficient_scope: This API key does not have the appointments:write scope.");
    expect([...h.out, ...h.err].join("\n")).not.toContain(key);
  });

  it("explains missing input without calling the server", async () => {
    const noKey = harness({}, () => Response.json({}));
    expect(await run(["services"], noKey.io)).toBe(2);
    expect(noKey.err[0]).toMatch(/KALENDR_API_KEY/);
    const noService = harness({ KALENDR_API_KEY: key }, () => Response.json({}));
    expect(await run(["times"], noService.io)).toBe(2);
    expect(noService.err[0]).toMatch(/--service/);
    expect(await run(["frobnicate"], noService.io)).toBe(2);
    expect(noService.fetch).not.toHaveBeenCalled();
  });

  it("prints the MCP settings for an assistant without needing a key", async () => {
    const h = harness({ KALENDR_URL: "https://book.example.com" }, () => Response.json({}));
    expect(await run(["mcp-config"], h.io)).toBe(0);
    expect(JSON.parse(h.out.join("\n")).mcpServers.kalendr.url).toBe("https://book.example.com/api/mcp");
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
