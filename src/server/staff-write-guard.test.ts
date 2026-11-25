import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } }, authIsConfigured: false }));
vi.mock("@/db/client", () => ({ getDatabase: () => null, withTenant: async () => [] }));

import { readOnlyImpersonationPermissions } from "@/lib/admin-access";
import { permissionKeys, resolvePermissions } from "@/lib/permissions";

import { assertNotImpersonating, assertNotReadOnlyImpersonation, requirePermission, type StaffContext } from "./staff-context";
import { impersonationPermissions } from "./staff-impersonation";

const root = resolve(__dirname, "../..");

/**
 * Routes that change nothing a "View as this business" session must not change. Keep this list short and give a reason
 * for every entry: anything not listed here must guard itself.
 */
const allowedWithoutGuard: Record<string, string> = {
  // Session-only on purpose (a business that wants a second factor must not block leaving it). It writes no business data, only
  // the browser's own "which of my businesses is open" cookie, and a support session reads the operator's own memberships.
  "src/app/api/staff/business/switch/route.ts": "sets only the caller's own browser preference",
  // The caller answers an invite to their own login. A platform operator's session never has one, so a support session can't
  // answer for anybody.
  "src/app/api/staff/invites/[id]/accept/route.ts": "answers the caller's own invite",
  "src/app/api/staff/invites/[id]/decline/route.ts": "answers the caller's own invite",
};

const handlerPattern = /^export async function (POST|PUT|PATCH|DELETE)\b[\s\S]*?^}\n/gm;
const readSet: readonly string[] = readOnlyImpersonationPermissions;

describe("every staff write route stops a read-only support session", () => {
  const files = [
    ...globSync("src/app/api/staff/**/route.ts", { cwd: root }),
    "src/app/api/appointments/[id]/status/route.ts",
  ].sort();

  it("finds the routes", () => {
    expect(files.length).toBeGreaterThan(60);
  });

  it("has a guard in each non-GET handler: assertNotReadOnlyImpersonation, or requirePermission of a key that is not a plain read", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");
      for (const match of source.matchAll(handlerPattern)) {
        const body = match[0];
        const permissions = [...body.matchAll(/requirePermission\(\w+, "([\w.]+)"/g)].map((found) => found[1] ?? "");
        const guarded = body.includes("assertNotReadOnlyImpersonation(") || body.includes("assertNotImpersonating(") || permissions.some((key) => !readSet.includes(key));
        if (!guarded && !(file in allowedWithoutGuard)) offenders.push(`${file} ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the allow-list honest: every entry still exists and needs it", () => {
    for (const file of Object.keys(allowedWithoutGuard)) expect(files).toContain(file);
  });
});

/** Routes that hand out a secret or a way to sign in as someone: refused in any support session, write access or not. */
const restricted = [
  "team/members/[id]/access-link", "security/policy", "calendars/connect/[provider]", "calendars/feed", "calendars/connections/[id]",
  "calendars/settings", "channels", "settings/data-protection", "privacy/requests/[id]", "privacy/retention",
  "webhooks", "webhooks/[id]", "webhooks/[id]/rotate-secret",
];

describe("routes that take secrets refuse every support session", () => {
  it("calls assertNotImpersonating in each non-GET handler", () => {
    for (const route of restricted) {
      const source = readFileSync(resolve(root, `src/app/api/staff/${route}/route.ts`), "utf8");
      const handlers = [...source.matchAll(handlerPattern)];
      expect(handlers.length, route).toBeGreaterThan(0);
      for (const handler of handlers) expect(handler[0], `${route} ${handler[1]}`).toContain("assertNotImpersonating(");
    }
  });

  it("refuses a write-access session too", () => {
    const write = context({ impersonation: banner(true) });
    expect(() => assertNotImpersonating(write)).toThrow(expect.objectContaining({ code: "support_session_restricted" }));
    expect(() => assertNotImpersonating(context({}))).not.toThrow();
  });
});

function context(overrides: Partial<StaffContext>): StaffContext {
  return {
    tenantId: "tenant", clinicSlug: "lotus", clinicName: "Lotus", role: "owner", permissions: [...permissionKeys],
    membershipId: null, userId: "operator", userName: "Kalendr support", userEmail: "support@kalendr.invalid", preview: false, ...overrides,
  };
}
const banner = (writeAccess: boolean) => ({ sessionId: "session", endsAt: new Date(Date.now() + 600_000).toISOString(), writeAccess, businessName: "Lotus" });

describe("permissions during a support session", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gives a read-only session only the plain read keys, and write sessions everything but people and privacy", () => {
    expect(impersonationPermissions(false)).toEqual(["records.view", "schedule.read", "audit.view", "reports.view", "reports.revenue"]);
    const write = impersonationPermissions(true);
    expect(write).not.toContain("team.manage");
    expect(write).not.toContain("privacy.manage");
    expect(write).toContain("settings.manage");
    expect(write).toContain("appointments.book");
  });

  it("refuses every write permission in a read-only session with read_only_support_session", () => {
    const readOnly = context({ permissions: impersonationPermissions(false), impersonation: banner(false) });
    for (const key of permissionKeys.filter((permission) => !readSet.includes(permission))) {
      expect(() => requirePermission(readOnly, key)).toThrow(expect.objectContaining({ status: 403, code: "read_only_support_session" }));
    }
    for (const key of readSet) expect(() => requirePermission(readOnly, key as (typeof permissionKeys)[number])).not.toThrow();
    expect(() => assertNotReadOnlyImpersonation(readOnly)).toThrow(/read-only/);
  });

  it("refuses a write even if the permission list were somehow widened", () => {
    const widened = context({ permissions: [...permissionKeys], impersonation: banner(false) });
    expect(() => requirePermission(widened, "appointments.book")).toThrow(expect.objectContaining({ code: "read_only_support_session" }));
  });

  it("lets a write session and ordinary staff pass the guard", () => {
    expect(() => assertNotReadOnlyImpersonation(context({ impersonation: banner(true) }))).not.toThrow();
    expect(() => assertNotReadOnlyImpersonation(context({}))).not.toThrow();
    expect(() => requirePermission(context({ role: "receptionist", permissions: resolvePermissions("receptionist", {}) }), "appointments.book")).not.toThrow();
  });
});

/** The waitlist and repeating-series routes check their permission inside the server layer, so each handler also guards at the route. */
const waitlistAndSeriesWrites = [
  "series", "series/preview", "series/[id]", "waitlist", "waitlist/[id]", "waitlist/[id]/offer", "waitlist/offers/[id]", "waitlist/services/[serviceId]", "waitlist/settings",
];

describe("waitlist and repeating-series write routes refuse a read-only support session", () => {
  it("guards every non-GET handler", () => {
    for (const route of waitlistAndSeriesWrites) {
      const source = readFileSync(resolve(root, `src/app/api/staff/${route}/route.ts`), "utf8");
      const handlers = [...source.matchAll(handlerPattern)];
      expect(handlers.length, route).toBeGreaterThan(0);
      for (const handler of handlers) {
        const permissions = [...handler[0].matchAll(/requirePermission\(\w+, "([\w.]+)"/g)].map((found) => found[1] ?? "");
        const guarded = handler[0].includes("assertNotReadOnlyImpersonation(") || permissions.some((key) => !readSet.includes(key));
        expect(guarded, `${route} ${handler[1]}`).toBe(true);
      }
    }
  });

  it("stops a read-only session before the series or waitlist permission is even looked at", () => {
    const readOnly = context({ permissions: impersonationPermissions(false), impersonation: banner(false) });
    for (const key of ["series.manage", "waitlist.manage"] as const) {
      expect(() => requirePermission(readOnly, key)).toThrow(expect.objectContaining({ status: 403, code: "read_only_support_session" }));
    }
  });
});
