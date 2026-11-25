import { z } from "zod";

/** The Postgres channel the `kalendr_notify_live` trigger sends on. */
export const LIVE_CHANNEL = "kalendr_live";

export const liveKinds = ["appointment", "queue", "message", "note", "payment", "notification"] as const;
export type LiveKind = (typeof liveKinds)[number];

/** What a staff screen hears: something of this kind changed. Screens refetch; they never read data from it. */
export type LiveSignal = { type: "change"; kind: LiveKind } | { type: "resync" };

/** The trigger's notice: a business id and a kind. No personal data. */
const noticeSchema = z.object({ t: z.string().min(1).max(80), k: z.enum(liveKinds) }).strict();

export function parseLiveNotice(payload: string): { tenantId: string; kind: LiveKind } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = noticeSchema.safeParse(raw);
  return parsed.success ? { tenantId: parsed.data.t, kind: parsed.data.k } : null;
}

type Listener = (signal: LiveSignal) => void;

/**
 * Fans database notices out to the open staff screens of one process, kept apart by business:
 * a screen only ever hears about its own business.
 */
export class LiveHub {
  private readonly byTenant = new Map<string, Set<Listener>>();

  subscribe(tenantId: string, listener: Listener): () => void {
    let listeners = this.byTenant.get(tenantId);
    if (!listeners) {
      listeners = new Set();
      this.byTenant.set(tenantId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.byTenant.get(tenantId);
      if (!current) return;
      current.delete(listener);
      if (!current.size) this.byTenant.delete(tenantId);
    };
  }

  /** One raw notice from Postgres. Malformed notices are dropped. */
  receive(payload: string): void {
    const notice = parseLiveNotice(payload);
    if (!notice) return;
    for (const listener of [...(this.byTenant.get(notice.tenantId) ?? [])]) {
      safely(listener, { type: "change", kind: notice.kind });
    }
  }

  /** After the listening connection came back: notices may have been missed, so every screen refetches. */
  resyncAll(): void {
    for (const listeners of this.byTenant.values()) {
      for (const listener of [...listeners]) safely(listener, { type: "resync" });
    }
  }

  get screenCount(): number {
    let count = 0;
    for (const listeners of this.byTenant.values()) count += listeners.size;
    return count;
  }
}

function safely(listener: Listener, signal: LiveSignal): void {
  try {
    listener(signal);
  } catch {
    // A closed screen must not stop the others hearing about the change.
  }
}
