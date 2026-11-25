/** @vitest-environment node */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { LiveHub } from "@/server/live/hub";

const hub = new LiveHub();
let nextTenant = "tenant_a";

vi.mock("server-only", () => ({}));
vi.mock("@/server/staff-context", () => ({
  getStaffContext: async () => ({ tenantId: nextTenant, preview: false }),
}));
vi.mock("@/server/live/listener", () => ({
  subscribeToLiveChanges: async (tenantId: string, listener: Parameters<LiveHub["subscribe"]>[1]) => hub.subscribe(tenantId, listener),
}));

import { GET } from "./route";

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe("staff event streams under load", () => {
  beforeEach(() => {
    expect(hub.screenCount).toBe(0);
  });

  it("keeps 200 streams open on one server, tells each its own business, and frees them all when the browsers go", async () => {
    const aborts: AbortController[] = [];
    const readers: { reader: ReadableStreamDefaultReader<Uint8Array>; tenant: string }[] = [];
    for (let screen = 0; screen < 200; screen += 1) {
      nextTenant = `tenant_${screen % 10}`;
      const controller = new AbortController();
      aborts.push(controller);
      const response = await GET(new Request("http://localhost/api/staff/events", { signal: controller.signal }));
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      readers.push({ reader: response.body!.getReader(), tenant: nextTenant });
    }
    expect(hub.screenCount).toBe(200);

    const ready = await Promise.all(readers.map(({ reader }) => readUntil(reader, "event: ready")));
    // Each stream asks its browser to wait a random 3 to 7 seconds before retrying, so a deploy does not stampede.
    const retries = ready.map((text) => Number(/retry: (\d+)/.exec(text)?.[1]));
    expect(Math.min(...retries)).toBeGreaterThanOrEqual(3_000);
    expect(Math.max(...retries)).toBeLessThanOrEqual(7_000);
    expect(new Set(retries).size).toBeGreaterThan(20);

    hub.receive(JSON.stringify({ t: "tenant_4", k: "appointment" }));
    const startedAt = Date.now();
    const heard = await Promise.all(readers.map(async ({ reader, tenant }) => (tenant === "tenant_4" ? readUntil(reader, "event: change") : null)));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(heard.filter(Boolean)).toHaveLength(20);
    for (const text of heard.filter((value): value is string => value !== null)) expect(text).toContain('"kind":"appointment"');

    for (const controller of aborts) controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hub.screenCount).toBe(0);
  });
});
