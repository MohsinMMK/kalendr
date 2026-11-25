import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, locations, memberships, teamMembers, teams } from "@/db/schema";
import type { PublicTeam, TeamInput, TeamUpdateInput, TeamView } from "@/lib/enterprise-contracts";
import { ApiError, getPostgresErrorCode } from "@/server/api-error";
import type { StaffContext } from "@/server/staff-context";

import { duplicateError, guardOrgRead } from "./guard";
import { guardTeamWrite } from "./team-guard";

type TenantTransaction = Parameters<Parameters<typeof withTenant>[1]>[0];

export function slugify(value: string): string {
  const slug = value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug.length >= 2 ? slug : `team-${slug || "x"}`;
}

async function uniqueSlug(transaction: TenantTransaction, tenantId: string, wanted: string): Promise<string> {
  const taken = new Set((await transaction.select({ slug: teams.slug }).from(teams).where(eq(teams.tenantId, tenantId))).map((row) => row.slug));
  if (!taken.has(wanted)) return wanted;
  for (let suffix = 2; suffix < 200; suffix++) if (!taken.has(`${wanted}-${suffix}`)) return `${wanted}-${suffix}`;
  throw new ApiError(409, "duplicate", "Choose a different team name.");
}

async function requireMembers(transaction: TenantTransaction, tenantId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await transaction.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.tenantId, tenantId), inArray(memberships.id, ids)));
  if (rows.length !== new Set(ids).size) throw new ApiError(400, "member_not_found", "Choose people who belong to this business.");
}

async function requireParent(transaction: TenantTransaction, tenantId: string, teamId: string | null, parentId: string | null | undefined): Promise<void> {
  if (!parentId) return;
  if (parentId === teamId) throw new ApiError(400, "team_loop", "A team can't sit under itself.");
  const [parent] = await transaction.select({ id: teams.id }).from(teams).where(and(eq(teams.tenantId, tenantId), eq(teams.id, parentId))).limit(1);
  if (!parent) throw new ApiError(400, "team_not_found", "Choose a team that exists.");
  if (!teamId) return;
  // Walking up from the new parent must never reach the team itself, or the tree would loop.
  const rows = await transaction.execute<{ id: string }>(sql`
    with recursive up as (
      select id, parent_team_id from teams where tenant_id = ${tenantId} and id = ${parentId}
      union
      select team.id, team.parent_team_id from teams as team join up on team.id = up.parent_team_id where team.tenant_id = ${tenantId}
    ) select id from up where id = ${teamId}`);
  if (rows.length > 0) throw new ApiError(400, "team_loop", "A team can't sit under one of its own sub-teams.");
}

async function requireLocation(transaction: TenantTransaction, tenantId: string, locationId: string | null | undefined): Promise<void> {
  if (!locationId) return;
  const [row] = await transaction.select({ id: locations.id }).from(locations).where(and(eq(locations.tenantId, tenantId), eq(locations.id, locationId))).limit(1);
  if (!row) throw new ApiError(400, "location_not_found", "Choose a branch that exists.");
}

export async function listTeams(context: StaffContext): Promise<TeamView[]> {
  guardOrgRead(context);
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(teams).where(eq(teams.tenantId, context.tenantId)).orderBy(teams.name);
    const links = await transaction.select({ teamId: teamMembers.teamId, membershipId: teamMembers.membershipId }).from(teamMembers).where(eq(teamMembers.tenantId, context.tenantId));
    const byTeam = new Map<string, string[]>();
    for (const link of links) byTeam.set(link.teamId, [...(byTeam.get(link.teamId) ?? []), link.membershipId]);
    return rows.map((row): TeamView => ({
      id: row.id, name: row.name, slug: row.slug, description: row.description, parentTeamId: row.parentTeamId, locationId: row.locationId,
      isPrivate: row.isPrivate, isActive: row.isActive, version: row.version,
      memberCount: byTeam.get(row.id)?.length ?? 0, membershipIds: byTeam.get(row.id) ?? [],
    }));
  });
}

async function setMembers(transaction: TenantTransaction, tenantId: string, teamId: string, ids: string[]): Promise<void> {
  await requireMembers(transaction, tenantId, ids);
  await transaction.delete(teamMembers).where(and(eq(teamMembers.tenantId, tenantId), eq(teamMembers.teamId, teamId)));
  const unique = [...new Set(ids)];
  if (unique.length > 0) await transaction.insert(teamMembers).values(unique.map((membershipId) => ({ tenantId, teamId, membershipId })));
}

export async function createTeam(context: StaffContext, input: TeamInput): Promise<TeamView> {
  guardTeamWrite(context);
  try {
    const created = await withTenant(context.tenantId, async (transaction) => {
      await requireParent(transaction, context.tenantId, null, input.parentTeamId);
      await requireLocation(transaction, context.tenantId, input.locationId);
      const slug = input.slug ?? await uniqueSlug(transaction, context.tenantId, slugify(input.name));
      const [row] = await transaction.insert(teams).values({
        tenantId: context.tenantId, name: input.name, slug, description: input.description ?? null, parentTeamId: input.parentTeamId ?? null,
        locationId: input.locationId ?? null, isPrivate: input.isPrivate ?? false, isActive: input.isActive ?? true,
      }).returning({ id: teams.id });
      if (!row) throw new Error("Team insert returned no row");
      await setMembers(transaction, context.tenantId, row.id, input.membershipIds ?? []);
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.team.created", outcome: "success",
        metadata: { teamId: row.id, isPrivate: input.isPrivate ?? false, memberCount: new Set(input.membershipIds ?? []).size },
      });
      return row.id;
    });
    return (await listTeams(context)).find((team) => team.id === created)!;
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw duplicateError("a team");
    throw error;
  }
}

export async function updateTeam(context: StaffContext, teamId: string, input: TeamUpdateInput): Promise<TeamView> {
  guardTeamWrite(context);
  try {
    await withTenant(context.tenantId, async (transaction) => {
      const [current] = await transaction.select().from(teams).where(and(eq(teams.tenantId, context.tenantId), eq(teams.id, teamId))).for("update").limit(1);
      if (!current) throw new ApiError(404, "team_not_found", "That team could not be found.");
      if (current.version !== input.version) throw new ApiError(409, "version_conflict", "Someone else changed this team. Reload and try again.");
      if (input.parentTeamId !== undefined) await requireParent(transaction, context.tenantId, teamId, input.parentTeamId);
      if (input.locationId !== undefined) await requireLocation(transaction, context.tenantId, input.locationId);
      await transaction.update(teams).set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.parentTeamId !== undefined ? { parentTeamId: input.parentTeamId } : {}),
        ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
        ...(input.isPrivate !== undefined ? { isPrivate: input.isPrivate } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        version: current.version + 1, updatedAt: new Date(),
      }).where(and(eq(teams.tenantId, context.tenantId), eq(teams.id, teamId)));
      if (input.membershipIds) await setMembers(transaction, context.tenantId, teamId, input.membershipIds);
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.team.updated", outcome: "success",
        metadata: { teamId, changed: Object.keys(input).filter((key) => key !== "version") },
      });
    });
    return (await listTeams(context)).find((team) => team.id === teamId)!;
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw duplicateError("a team");
    throw error;
  }
}

export async function deleteTeam(context: StaffContext, teamId: string): Promise<{ deleted: true }> {
  guardTeamWrite(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [child] = await transaction.select({ id: teams.id }).from(teams).where(and(eq(teams.tenantId, context.tenantId), eq(teams.parentTeamId, teamId))).limit(1);
    if (child) throw new ApiError(409, "team_has_children", "This team has sub-teams. Move or delete them first.");
    const removed = await transaction.delete(teams).where(and(eq(teams.tenantId, context.tenantId), eq(teams.id, teamId))).returning({ id: teams.id });
    if (removed.length === 0) throw new ApiError(404, "team_not_found", "That team could not be found.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.team.deleted", outcome: "success", metadata: { teamId },
    });
    return { deleted: true as const };
  });
}

/**
 * The public team page's data, by the team's address name. A private team still books but lists nobody: its people are
 * left out here, not hidden by the screen, so no page or script can show them.
 */
export async function loadPublicTeam(tenantId: string, teamSlug: string): Promise<PublicTeam | null> {
  return withTenant(tenantId, async (transaction) => {
    const [team] = await transaction.select().from(teams).where(and(eq(teams.tenantId, tenantId), eq(teams.slug, teamSlug), eq(teams.isActive, true))).limit(1);
    if (!team) return null;
    const parent = team.parentTeamId
      ? (await transaction.select({ name: teams.name, slug: teams.slug }).from(teams).where(and(eq(teams.tenantId, tenantId), eq(teams.id, team.parentTeamId), eq(teams.isActive, true))).limit(1))[0] ?? null
      : null;
    const children = await transaction.select({ name: teams.name, slug: teams.slug }).from(teams)
      .where(and(eq(teams.tenantId, tenantId), eq(teams.parentTeamId, team.id), eq(teams.isActive, true))).orderBy(teams.name);
    // Everyone in the team and in the sub-teams under it.
    const people = await transaction.execute<{ practitioner_id: string }>(sql`
      with recursive down as (
        select id from teams where tenant_id = ${tenantId} and id = ${team.id} and is_active
        union
        select child.id from teams as child join down on child.parent_team_id = down.id where child.tenant_id = ${tenantId} and child.is_active
      )
      select distinct practitioner.id as practitioner_id
      from team_members as link
      join down on down.id = link.team_id
      join memberships as membership on membership.tenant_id = link.tenant_id and membership.id = link.membership_id and membership.is_active
      join practitioners as practitioner on practitioner.tenant_id = membership.tenant_id and practitioner.auth_user_id = membership.user_id and practitioner.is_active
      where link.tenant_id = ${tenantId}`);
    const ids = people.map((row) => row.practitioner_id);
    return {
      id: team.id, name: team.name, slug: team.slug, description: team.description, isPrivate: team.isPrivate, parent, children,
      practitionerIds: team.isPrivate ? [] : ids,
      serviceFromPractitionerIds: ids,
    };
  });
}
