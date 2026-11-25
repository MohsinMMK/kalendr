import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { auditEvents, memberships, teamMembers, teams } from "@/db/schema";
import { getPostgresErrorCode } from "@/server/api-error";
import { slugify } from "@/server/enterprise/teams";

import type { ScimContext } from "./auth";
import { ScimError, listResponse, parseListQuery, scimGroupSchemaId, type PatchOperation } from "./protocol";

type TenantTransaction = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * Directory groups are teams (feature 53). A group the directory makes becomes a public team; a member added by the directory
 * is a person already in this business. A group's members are never created here: people come from the Users resource.
 */

async function groupResource(transaction: TenantTransaction, tenantId: string, teamId: string, baseUrl: string): Promise<unknown> {
  const [team] = await transaction.select().from(teams).where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId))).limit(1);
  if (!team) throw new ScimError(404, "That group does not exist.");
  const members = await transaction.execute<{ membership_id: string; name: string }>(sql`
    select link.membership_id, person.name from team_members as link
    join memberships as membership on membership.tenant_id = link.tenant_id and membership.id = link.membership_id
    join auth_users as person on person.id = membership.user_id
    where link.tenant_id = ${tenantId} and link.team_id = ${teamId} order by person.name`);
  return {
    schemas: [scimGroupSchemaId], id: team.id, displayName: team.name,
    members: members.map((member) => ({ value: member.membership_id, display: member.name, $ref: `${baseUrl}/Users/${member.membership_id}` })),
    meta: { resourceType: "Group", created: team.createdAt.toISOString(), lastModified: team.updatedAt.toISOString(), location: `${baseUrl}/Groups/${team.id}` },
  };
}

export async function listGroups(context: ScimContext, url: URL, baseUrl: string): Promise<unknown> {
  const query = parseListQuery(url);
  return withTenant(context.tenantId, async (transaction) => {
    const filtered = query.filter?.attribute === "displayname" ? sql` and lower(name) = ${query.filter.value.toLowerCase()}` : sql``;
    const [{ total } = { total: 0 }] = await transaction.execute<{ total: number }>(sql`select count(*)::int as total from teams where tenant_id = ${context.tenantId}${filtered}`);
    const rows = await transaction.execute<{ id: string }>(sql`select id from teams where tenant_id = ${context.tenantId}${filtered} order by name limit ${query.count} offset ${query.startIndex - 1}`);
    const resources = [];
    for (const row of rows) resources.push(await groupResource(transaction, context.tenantId, row.id, baseUrl));
    return listResponse(resources, total, query.startIndex);
  });
}

export async function getGroup(context: ScimContext, teamId: string, baseUrl: string): Promise<unknown> {
  return withTenant(context.tenantId, (transaction) => groupResource(transaction, context.tenantId, teamId, baseUrl));
}

export const groupInputSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  members: z.array(z.object({ value: z.string().trim().min(1).max(64) })).max(500).optional(),
}).passthrough();
export type GroupInput = z.infer<typeof groupInputSchema>;

/** Only people who belong to this business can be put in a team; an id from anywhere else is refused, not skipped. */
async function requireMembers(transaction: TenantTransaction, tenantId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await transaction.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.tenantId, tenantId), inArray(memberships.id, ids)));
  if (rows.length !== new Set(ids).size) throw new ScimError(400, "A member in that group is not a user of this business.", "invalidValue");
}

async function setMembers(transaction: TenantTransaction, tenantId: string, teamId: string, ids: string[]): Promise<void> {
  await requireMembers(transaction, tenantId, ids);
  await transaction.delete(teamMembers).where(and(eq(teamMembers.tenantId, tenantId), eq(teamMembers.teamId, teamId)));
  const unique = [...new Set(ids)];
  if (unique.length > 0) await transaction.insert(teamMembers).values(unique.map((membershipId) => ({ tenantId, teamId, membershipId })));
}

async function record(transaction: TenantTransaction, context: ScimContext, teamId: string, change: string): Promise<void> {
  await transaction.insert(auditEvents).values({ tenantId: context.tenantId, actorType: "system", action: "enterprise.scim.group_changed", outcome: "success", metadata: { tokenId: context.tokenId, teamId, change } });
}

export async function createGroup(context: ScimContext, input: GroupInput, baseUrl: string): Promise<unknown> {
  try {
    return await withTenant(context.tenantId, async (transaction) => {
      const taken = new Set((await transaction.select({ slug: teams.slug }).from(teams).where(eq(teams.tenantId, context.tenantId))).map((row) => row.slug));
      const base = slugify(input.displayName);
      let slug = base;
      for (let suffix = 2; taken.has(slug) && suffix < 200; suffix += 1) slug = `${base}-${suffix}`;
      const [team] = await transaction.insert(teams).values({ tenantId: context.tenantId, name: input.displayName, slug }).returning({ id: teams.id });
      await setMembers(transaction, context.tenantId, team!.id, (input.members ?? []).map((member) => member.value));
      await record(transaction, context, team!.id, "created");
      return groupResource(transaction, context.tenantId, team!.id, baseUrl);
    });
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw new ScimError(409, "A group with that name already exists.", "uniqueness");
    throw error;
  }
}

export async function replaceGroup(context: ScimContext, teamId: string, input: GroupInput, baseUrl: string): Promise<unknown> {
  return withTenant(context.tenantId, async (transaction) => {
    await groupResource(transaction, context.tenantId, teamId, baseUrl);
    await transaction.update(teams).set({ name: input.displayName, updatedAt: new Date() }).where(and(eq(teams.tenantId, context.tenantId), eq(teams.id, teamId)));
    await setMembers(transaction, context.tenantId, teamId, (input.members ?? []).map((member) => member.value));
    await record(transaction, context, teamId, "replaced");
    return groupResource(transaction, context.tenantId, teamId, baseUrl);
  });
}

function memberIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => (entry && typeof entry === "object" && "value" in entry && typeof entry.value === "string" ? [entry.value] : []));
}

/** PATCH: add, remove and replace on `members`, and replace on `displayName`. A remove with a path names its member: `members[value eq "id"]`. */
export async function patchGroup(context: ScimContext, teamId: string, operations: PatchOperation[], baseUrl: string): Promise<unknown> {
  return withTenant(context.tenantId, async (transaction) => {
    await groupResource(transaction, context.tenantId, teamId, baseUrl);
    const current = new Set((await transaction.select({ id: teamMembers.membershipId }).from(teamMembers).where(and(eq(teamMembers.tenantId, context.tenantId), eq(teamMembers.teamId, teamId)))).map((row) => row.id));
    let next = new Set(current);
    for (const operation of operations) {
      const path = (operation.path ?? "").trim();
      if (path.toLowerCase() === "displayname" && typeof operation.value === "string" && operation.value.trim().length >= 2) {
        await transaction.update(teams).set({ name: operation.value.trim().slice(0, 120), updatedAt: new Date() }).where(and(eq(teams.tenantId, context.tenantId), eq(teams.id, teamId)));
        continue;
      }
      const named = /^members\[value eq "([^"]+)"\]$/i.exec(path);
      if (named?.[1] && operation.op === "remove") { next.delete(named[1]); continue; }
      if (path.toLowerCase() === "members" || (!path && operation.value && typeof operation.value === "object" && "members" in operation.value)) {
        const value = path ? operation.value : (operation.value as { members: unknown }).members;
        const ids = memberIds(value);
        if (operation.op === "add") ids.forEach((id) => next.add(id));
        else if (operation.op === "replace") next = new Set(ids);
        else if (ids.length === 0) next = new Set();
        else ids.forEach((id) => next.delete(id));
      }
    }
    await setMembers(transaction, context.tenantId, teamId, [...next]);
    await record(transaction, context, teamId, "members");
    return groupResource(transaction, context.tenantId, teamId, baseUrl);
  });
}

export async function removeGroup(context: ScimContext, teamId: string): Promise<void> {
  await withTenant(context.tenantId, async (transaction) => {
    const [child] = await transaction.select({ id: teams.id }).from(teams).where(and(eq(teams.tenantId, context.tenantId), eq(teams.parentTeamId, teamId))).limit(1);
    if (child) throw new ScimError(409, "This group has sub-teams in Kalendr. Remove those first.");
    const removed = await transaction.delete(teams).where(and(eq(teams.tenantId, context.tenantId), eq(teams.id, teamId))).returning({ id: teams.id });
    if (removed.length === 0) throw new ScimError(404, "That group does not exist.");
    await record(transaction, context, teamId, "deleted");
  });
}
