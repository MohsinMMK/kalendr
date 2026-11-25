import { vi } from "vitest";

import type { CouponView, CustomerMembershipView, CustomerPackageView, MembershipPlanView, PackageView } from "@/lib/offers-contracts";
import { staffSnapshotFixture } from "@/test/staff-fixture";

export const packageView = (patch: Partial<PackageView> = {}): PackageView => ({
  id: "pk1", name: "10 cleanings", description: null, priceMinor: 450000, currency: "INR", credits: 10, validDays: 365, serviceIds: ["service_cleaning"], isActive: true, version: 1, sold: 3, creditsOutstanding: 18, ...patch,
});
export const planView = (patch: Partial<MembershipPlanView> = {}): MembershipPlanView => ({
  id: "pl1", name: "Gold membership", description: null, priceMinor: 99900, currency: "INR", creditsPerPeriod: 2, memberDiscountPercent: 10, serviceIds: ["service_cleaning"], isActive: true, version: 1, activeMembers: 4, ...patch,
});
export const couponView = (patch: Partial<CouponView> = {}): CouponView => ({
  id: "cp1", code: "WELCOME10", kind: "percent", value: 10, maxUses: 50, perCustomerLimit: 1, validFrom: null, validTo: null, serviceIds: [], firstVisitOnly: false, stackable: false, isActive: true, version: 1, used: 12, ...patch,
});
export const customerPackage = (patch: Partial<CustomerPackageView> = {}): CustomerPackageView => ({
  id: "cpk1", patientId: "pat1", name: "10 cleanings", source: "package", creditsTotal: 10, remaining: 7, boughtAt: "2026-01-10T09:00:00.000Z", expiresAt: "2027-03-30T09:00:00.000Z", status: "active", serviceIds: ["service_cleaning"], invoiceId: "inv1",
  ledger: [
    { id: "l1", change: 10, kind: "purchase", reason: "Bought 10 cleanings", appointmentId: null, at: "2026-01-10T09:00:00.000Z" },
    { id: "l2", change: -1, kind: "use", reason: "Routine cleaning on 12 Feb", appointmentId: "apt1", at: "2026-02-12T09:00:00.000Z" },
    { id: "l3", change: -2, kind: "adjust", reason: "Gift reversed", appointmentId: null, at: "2026-03-01T09:00:00.000Z" },
  ], ...patch,
});
export const membershipView = (patch: Partial<CustomerMembershipView> = {}): CustomerMembershipView => ({
  id: "mem1", patientId: "pat1", planId: "pl1", planName: "Gold membership", status: "active", currentPeriodEnd: "2026-12-20T09:00:00.000Z", benefitsOn: true, graceEndsAt: null, ...patch,
});

export interface Req { url: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> }
export const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
export const failure = (status: number, code: string, message: string, fieldErrors?: Record<string, string[]>) => new Response(JSON.stringify({ error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } }), { status });

/** Stubs fetch: the snapshot answers by itself, everything else goes to `handler` (undefined means 404). Returns the requests seen. */
export function installFetch(handler: (request: Req, url: URL) => Response | Promise<Response> | undefined): Req[] {
  const requests: Req[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://x");
    if (url.pathname === "/api/staff/snapshot") return json(staffSnapshotFixture);
    const request: Req = { url: input, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> };
    requests.push(request);
    return handler(request, url) ?? failure(404, "not_found", "No.");
  }));
  return requests;
}

export function stubKeys() {
  let n = 0;
  vi.stubGlobal("crypto", Object.assign(Object.create(globalThis.crypto), { randomUUID: () => `key-${++n}` }));
}
