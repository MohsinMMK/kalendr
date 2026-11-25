/** @vitest-environment node */

import { describe, expect, it, vi } from "vitest";

import { LiveHub, parseLiveNotice } from "./hub";

const notice = (tenantId: string, kind: string) => JSON.stringify({ t: tenantId, k: kind });

describe("live updates hub", () => {
  it("tells only the screens of the business that changed", () => {
    const hub = new LiveHub();
    const tenantA = vi.fn();
    const tenantB = vi.fn();
    hub.subscribe("tenant_a", tenantA);
    hub.subscribe("tenant_b", tenantB);

    hub.receive(notice("tenant_a", "appointment"));

    expect(tenantA).toHaveBeenCalledWith({ type: "change", kind: "appointment" });
    expect(tenantB).not.toHaveBeenCalled();
  });

  it("drops notices that are malformed, unknown, or carry anything extra", () => {
    const hub = new LiveHub();
    const listener = vi.fn();
    hub.subscribe("tenant_a", listener);

    hub.receive("not json");
    hub.receive(notice("tenant_a", "invoice"));
    hub.receive(JSON.stringify({ t: "tenant_a", k: "message", name: "Asha" }));

    expect(listener).not.toHaveBeenCalled();
    expect(parseLiveNotice(notice("tenant_a", "note"))).toEqual({ tenantId: "tenant_a", kind: "note" });
  });

  it("stops telling a screen once it has closed, and keeps telling the others", () => {
    const hub = new LiveHub();
    const closed = vi.fn();
    const open = vi.fn();
    const unsubscribe = hub.subscribe("tenant_a", closed);
    hub.subscribe("tenant_a", open);

    unsubscribe();
    hub.receive(notice("tenant_a", "queue"));

    expect(closed).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    expect(hub.screenCount).toBe(1);
  });

  it("keeps telling other screens when one throws", () => {
    const hub = new LiveHub();
    const broken = vi.fn(() => { throw new Error("closed stream"); });
    const healthy = vi.fn();
    hub.subscribe("tenant_a", broken);
    hub.subscribe("tenant_a", healthy);

    hub.receive(notice("tenant_a", "message"));

    expect(healthy).toHaveBeenCalledOnce();
  });

  it("asks every open screen to refetch after the listening connection comes back", () => {
    const hub = new LiveHub();
    const tenantA = vi.fn();
    const tenantB = vi.fn();
    hub.subscribe("tenant_a", tenantA);
    hub.subscribe("tenant_b", tenantB);

    hub.resyncAll();

    expect(tenantA).toHaveBeenCalledWith({ type: "resync" });
    expect(tenantB).toHaveBeenCalledWith({ type: "resync" });
  });
});
