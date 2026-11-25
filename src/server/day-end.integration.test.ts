/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));

import { closeDay, getDayEnd, summaryChanged } from "@/server/day-end";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeLocal = isolatedDatabaseReady(runtimeUrl, ownerUrl) ? describe : describe.skip;

// A day long before any seeded visit, so the totals are known to be zero and nothing real is closed.
const DAY = "2001-02-03";

describeLocal("closing the day", () => {
  let owner: postgres.Sql;
  let tenantId = "";
  let otherTenantId = "";

  const staff = (tenant: string, permissions = resolvePermissions("owner", {})): StaffContext => ({
    tenantId: tenant, clinicSlug: "lotus-dental", clinicName: "Lotus Dental Studio", role: "owner", permissions,
    membershipId: null, userId: null, userName: "Day Closer", userEmail: "test@example.com", preview: false,
  });

  async function removeTestCloses() {
    await owner.begin(async (transaction) => {
      await transaction`alter table day_closes disable trigger day_closes_final`;
      await transaction`delete from day_closes where day = ${DAY}`;
      await transaction`alter table day_closes enable trigger day_closes_final`;
      await transaction`delete from audit_events where action = 'day.closed' and metadata->>'day' = ${DAY}`;
    });
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [other] = await owner<{ id: string }[]>`select id from tenants where slug <> 'lotus-dental' order by slug limit 1`;
    if (!tenant || !other) throw new Error("Seed the isolated local database before this test");
    tenantId = tenant.id;
    otherTenantId = other.id;
    await removeTestCloses();
  });

  afterAll(async () => {
    await removeTestCloses().catch((error: unknown) => console.error("day-end test cleanup failed", error));
    await owner`delete from idempotency_keys where route = 'staff.day_end.close' and created_at > now() - interval '5 minutes'`;
    await owner.end();
  });

  it("sums an empty day as zeros, with nothing closed yet", async () => {
    const result = await getDayEnd(staff(tenantId), { day: DAY });
    expect(result.close).toBeNull();
    expect(result.summary.visits).toMatchObject({ total: 0, seen: 0, noShows: 0, avgWaitMinutes: null });
    expect(result.summary.money).toMatchObject({ takenMinor: 0, refundedMinor: 0, netMinor: 0, cashExpectedMinor: 0, owedMinor: 0 });
  });

  it("closes the day once, replays a repeat of the same request, and refuses a second close", async () => {
    const key = randomUUID();
    const input = { day: DAY, cashCountedMinor: 1_500, note: "Float left in" };
    const closed = await closeDay(staff(tenantId), input, key);
    expect(closed.close).toMatchObject({ byName: "Day Closer", cashCountedMinor: 1_500, cashExpectedMinor: 0, note: "Float left in" });
    expect(closed.changedSinceClose).toBe(false);

    await expect(closeDay(staff(tenantId), input, key)).resolves.toEqual(closed);
    await expect(closeDay(staff(tenantId), input, randomUUID())).rejects.toMatchObject({ status: 409, code: "day_already_closed" });

    const [audit] = await owner<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events where tenant_id = ${tenantId} and action = 'day.closed' and metadata->>'day' = ${DAY}
    `;
    expect(audit?.metadata).toMatchObject({ cashCountedMinor: 1_500, cashExpectedMinor: 0 });
    expect(JSON.stringify(audit?.metadata)).not.toContain("Float");
  });

  it("never lets a closed day be edited or removed", async () => {
    await expect(owner`update day_closes set cash_counted_minor = 0 where day = ${DAY}`).rejects.toThrow(/cannot be changed/);
    await expect(owner`delete from day_closes where day = ${DAY}`).rejects.toThrow(/cannot be changed/);
  });

  it("keeps one business's close out of another's", async () => {
    const result = await getDayEnd(staff(otherTenantId), { day: DAY });
    expect(result.close).toBeNull();
  });

  it("refuses a day that hasn't happened, and people without the permission", async () => {
    await expect(closeDay(staff(tenantId), { day: "2999-01-01", cashCountedMinor: 0 }, randomUUID()))
      .rejects.toMatchObject({ status: 409, code: "day_not_over" });
    await expect(getDayEnd(staff(tenantId, resolvePermissions("practitioner", {})), { day: DAY }))
      .rejects.toMatchObject({ status: 403 });
  });

  it("notices when the day moved after closing", async () => {
    const { summary } = await getDayEnd(staff(tenantId), { day: DAY });
    expect(summaryChanged(summary, summary)).toBe(false);
    expect(summaryChanged(summary, { ...summary, money: { ...summary.money, refundedMinor: 100 } })).toBe(true);
  });
});
