/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { schema } from "@/db/schema";
import type { KalendrDatabase } from "@/db/client";
import { deleteExpiredRateLimitBuckets, hitRateLimit, rateLimitKeyHash } from "@/server/rate-limit";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
// Only the isolated PostgreSQL 18 check (5545) or a throwaway database of your own (5609), never the shared one.
const isIsolated = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5545", "5609"].includes(parsed.port) && parsed.pathname === "/kalendr_local";
};
const describeIsolated = isIsolated(runtimeUrl) && isIsolated(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

describeIsolated("rate limits in PostgreSQL", () => {
  // Two separate connection pools as the runtime role: two app servers sharing one database.
  const servers: { client: postgres.Sql; database: KalendrDatabase }[] = [];
  let owner: postgres.Sql;
  const connect = () => {
    const client = postgres(runtimeUrl!, { max: 4, prepare: false });
    const server = { client, database: drizzle(client, { schema }) as KalendrDatabase };
    servers.push(server);
    return server;
  };

  beforeAll(() => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
  });
  afterAll(async () => {
    await Promise.all(servers.map((server) => server.client.end()));
    await owner.end();
  });

  it("shares one count between two app servers and keeps it after a restart", async () => {
    const key = `198.51.100.${Math.floor(Math.random() * 200)}-${randomUUID()}`;
    const now = new Date();
    const first = connect();
    const second = connect();
    const counts: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const server = attempt % 2 === 0 ? first : second;
      counts.push((await hitRateLimit("registration.ip", key, { now, database: server.database })).count);
    }
    expect(counts).toEqual([1, 2, 3, 4]);

    // "Restart": both pools go away, a new one picks up where they left off.
    await first.client.end();
    await second.client.end();
    const restarted = connect();
    expect(await hitRateLimit("registration.ip", key, { now, database: restarted.database })).toMatchObject({ count: 5, allowed: true });
    expect(await hitRateLimit("registration.ip", key, { now, database: restarted.database })).toMatchObject({ count: 6, allowed: false, limit: 5 });
  });

  it("never loses a count when requests arrive at once", async () => {
    const key = randomUUID();
    const now = new Date();
    const [a, b] = [connect(), connect()];
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) => hitRateLimit("booking.ip", key, { now, database: (index % 2 ? a : b).database })),
    );
    expect(results.map((result) => result.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
  });

  it("stores a hash, not the address, and starts again in the next window", async () => {
    const key = `203.0.113.${Math.floor(Math.random() * 200)}`;
    const { database } = connect();
    const now = new Date("2026-11-12T10:59:59Z");
    await hitRateLimit("code_request.ip", `${key}#${now.getTime()}`, { now, database });
    const rows = await owner<{ key_hash: string; count: number }[]>`
      select key_hash, count from rate_limit_buckets where key_hash = ${rateLimitKeyHash("code_request.ip", `${key}#${now.getTime()}`)}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key_hash).not.toContain(key);
    const next = await hitRateLimit("code_request.ip", `${key}#${now.getTime()}`, { now: new Date("2026-11-12T11:00:00Z"), database });
    expect(next).toMatchObject({ count: 1, allowed: true });
  });

  it("nightly cleanup deletes only windows that have ended", async () => {
    const { database } = connect();
    const old = randomUUID();
    const current = randomUUID();
    await hitRateLimit("availability.ip", old, { now: new Date("2026-01-01T00:00:10Z"), database });
    await hitRateLimit("availability.ip", current, { now: new Date(), database });
    const removed = await deleteExpiredRateLimitBuckets(new Date(), database);
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await owner<{ key_hash: string }[]>`
      select key_hash from rate_limit_buckets where key_hash in (${rateLimitKeyHash("availability.ip", old)}, ${rateLimitKeyHash("availability.ip", current)})`;
    expect(left.map((row) => row.key_hash)).toEqual([rateLimitKeyHash("availability.ip", current)]);
  });

  it("keeps counts positive", async () => {
    await expect(owner`insert into rate_limit_buckets (key_hash, window_start, window_end, count) values ('x', now(), now(), 0)`).rejects.toThrow(/rate_limit_buckets_count_positive/);
  });
});
