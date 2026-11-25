import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type postgres from "postgres";

import { withTenant } from "@/db/client";
import { memberships } from "@/db/schema";
import { resolvePermissions, type StaffRole } from "@/lib/permissions";
import { loadCustomPermissions } from "@/server/enterprise/role-permissions";
import type { StaffContext } from "@/server/staff-context";

import type { TenantFixture } from "./privacy-fixture";

export interface MemberFixture {
  userId: string;
  membershipId: string;
  email: string;
  name: string;
}

/** A person with a sign-in and a membership, made as the table owner. */
export async function addMember(owner: postgres.Sql, tenantId: string, role: StaffRole, options: { email?: string; name?: string; active?: boolean } = {}): Promise<MemberFixture> {
  const userId = randomUUID();
  const email = options.email ?? `member-${userId.slice(0, 8)}@example.com`;
  const name = options.name ?? `Member ${userId.slice(0, 6)}`;
  await owner`insert into auth_users (id, name, email, email_verified, password_set_at) values (${userId}, ${name}, ${email}, true, now())`;
  const [row] = await owner<{ id: string }[]>`
    insert into memberships (tenant_id, user_id, role, is_active) values (${tenantId}, ${userId}, ${role}, ${options.active ?? true}) returning id`;
  return { userId, membershipId: row!.id, email, name };
}

/** The context `getStaffContext` would build for this member right now, so a test exercises the real permission rules. */
export async function contextForMember(fixture: Pick<TenantFixture, "tenantId" | "slug">, member: MemberFixture, overrides: Partial<StaffContext> = {}): Promise<StaffContext> {
  const { row, custom } = await withTenant(fixture.tenantId, async (transaction) => ({
    row: (await transaction.select({ role: memberships.role, overrides: memberships.permissionOverrides }).from(memberships).where(eq(memberships.id, member.membershipId)).limit(1))[0]!,
    custom: await loadCustomPermissions(transaction, fixture.tenantId, member.membershipId),
  }));
  return {
    tenantId: fixture.tenantId, clinicSlug: fixture.slug, clinicName: "Enterprise test", role: row.role, permissions: resolvePermissions(row.role, row.overrides, custom),
    membershipId: member.membershipId, userId: member.userId, userName: member.name, userEmail: member.email,
    secondFactorEnrolled: true, secondFactorAt: new Date(), preview: false, ...overrides,
  };
}
