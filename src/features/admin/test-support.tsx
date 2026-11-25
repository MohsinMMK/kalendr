import { vi } from "vitest";
import type { ReactNode } from "react";

import { TestQueryProvider } from "@/test/query-wrapper";
import type { PlatformRole } from "@/lib/admin-contracts";

import { AdminRoleProvider } from "./admin-role";

export type Reply = { status?: number; body: unknown };

/** Replaces `fetch`; the handler answers by URL. Returns the calls so a test can check what was sent. */
export function mockFetch(handler: (url: string, init?: RequestInit) => Reply | Promise<Reply>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const result = await handler(url, init);
    const status = result.status ?? 200;
    return { ok: status < 400, status, json: async () => result.body } as Response;
  }));
  return calls;
}

export const data = (value: unknown): Reply => ({ body: { data: value } });
export const fail = (status: number, code: string, message: string, fieldErrors?: Record<string, string[]>): Reply => ({ status, body: { error: { code, message, fieldErrors } } });

export function Wrap({ role = "support", children }: { role?: PlatformRole; children: ReactNode }) {
  return <TestQueryProvider><AdminRoleProvider role={role}>{children}</AdminRoleProvider></TestQueryProvider>;
}

export function tenantRow(over: Record<string, unknown> = {}) {
  return { tenantId: "tenant-0001", slug: "city-clinic", name: "City Clinic", businessType: "clinic", createdAt: "2026-11-01T08:00:00.000Z", lastActiveAt: "2026-11-19T08:00:00.000Z", isActive: true, pausedAt: null, staffCount: 4, setupStage: "first_booking", planKey: "pro", planStatus: "active", ...over };
}

export function health(over: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-0001", slug: "city-clinic", name: "City Clinic", businessType: "clinic", createdAt: "2026-11-01T08:00:00.000Z", isActive: true, pausedAt: null,
    features: { waitlist: true, records: false }, staffCount: 4, appointments30d: 120,
    messages7d: { "whatsapp:delivered": 40, "whatsapp:failed": 3, "email:delivered": 10 },
    recentErrors: [{ code: "whatsapp_template_rejected", count: 3 }], deadLetters: 2, lastStaffActivityAt: "2026-11-19T07:00:00.000Z", billing: null, ...over,
  };
}
