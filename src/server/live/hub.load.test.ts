/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { jittered } from "@/features/clinic/use-live-events";

import { LiveHub, type LiveSignal } from "./hub";

describe("200 open streams on one server", () => {
  it("tells every screen of a business exactly once, and nobody else, quickly", () => {
    const hub = new LiveHub();
    const heard = new Map<number, LiveSignal[]>();
    const stops: (() => void)[] = [];
    // 200 screens across 20 businesses, 10 each.
    for (let screen = 0; screen < 200; screen += 1) {
      const signals: LiveSignal[] = [];
      heard.set(screen, signals);
      stops.push(hub.subscribe(`tenant_${screen % 20}`, (signal) => signals.push(signal)));
    }
    expect(hub.screenCount).toBe(200);

    const startedAt = performance.now();
    for (let round = 0; round < 50; round += 1) hub.receive(JSON.stringify({ t: "tenant_3", k: "appointment" }));
    const elapsed = performance.now() - startedAt;

    for (const [screen, signals] of heard) {
      expect(signals).toHaveLength(screen % 20 === 3 ? 50 : 0);
    }
    // 500 deliveries; a loose ceiling that only a real regression (per-event work growing with screens) would break.
    expect(elapsed).toBeLessThan(250);

    hub.resyncAll();
    for (const signals of heard.values()) expect(signals.at(-1)).toEqual({ type: "resync" });

    for (const stop of stops) stop();
    expect(hub.screenCount).toBe(0);
  });

  it("one closed screen never stops the others hearing", () => {
    const hub = new LiveHub();
    let reached = 0;
    hub.subscribe("t", () => { throw new Error("socket closed"); });
    for (let screen = 0; screen < 199; screen += 1) hub.subscribe("t", () => { reached += 1; });
    hub.receive(JSON.stringify({ t: "t", k: "queue" }));
    expect(reached).toBe(199);
  });

  it("after a deploy the 200 screens reconnect spread out, not all at once", () => {
    // Each screen waits a random time between 15 and 30 seconds before its first retry.
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const waits = Array.from({ length: 200 }, () => jittered(15_000, random));
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(15_000);
    expect(Math.max(...waits)).toBeLessThanOrEqual(30_000);
    const perSecond = new Map<number, number>();
    for (const wait of waits) perSecond.set(Math.floor(wait / 1_000), (perSecond.get(Math.floor(wait / 1_000)) ?? 0) + 1);
    // Spread over many seconds, with no second taking more than a small share of the crowd.
    expect(perSecond.size).toBeGreaterThanOrEqual(12);
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(30);
  });
});
