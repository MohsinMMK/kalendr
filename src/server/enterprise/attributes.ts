import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { attributeDefinitions, auditEvents, practitionerAttributes, practitioners } from "@/db/schema";
import type { AttributeDefinitionInput, AttributeKind, AttributeView, PersonAttributesInput, PersonAttributesView } from "@/lib/enterprise-contracts";
import { ApiError, getPostgresErrorCode } from "@/server/api-error";
import type { StaffContext } from "@/server/staff-context";

import { duplicateError, guardOrgRead } from "./guard";
import { guardTeamWrite } from "./team-guard";

type Stored = string | number | string[];

function view(row: typeof attributeDefinitions.$inferSelect): AttributeView {
  return { id: row.id, name: row.name, kind: row.kind as AttributeKind, options: row.options, position: row.position, version: row.version };
}

/** A value fits its attribute: text is short text, number is finite, choices are among the options. Anything else is refused. */
export function checkAttributeValue(attribute: Pick<AttributeView, "kind" | "options" | "name">, value: unknown): Stored {
  const fail = (message: string): never => { throw new ApiError(400, "invalid_attribute_value", message, { [attribute.name]: [message] }); };
  switch (attribute.kind) {
    case "text":
      return typeof value === "string" && value.length > 0 && value.length <= 300 ? value : fail(`${attribute.name} needs some text.`);
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : fail(`${attribute.name} needs a number.`);
    case "single": {
      const chosen = typeof value === "string" ? value : "";
      return attribute.options.includes(chosen) ? chosen : fail(`Choose one of the options for ${attribute.name}.`);
    }
    case "multiple": {
      const chosen = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
      if (chosen.length === 0 || chosen.length !== (value as unknown[]).length || chosen.some((entry) => !attribute.options.includes(entry))) fail(`Choose from the options for ${attribute.name}.`);
      return [...new Set(chosen)];
    }
  }
}

export async function listAttributes(context: StaffContext): Promise<AttributeView[]> {
  guardOrgRead(context);
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) =>
    (await transaction.select().from(attributeDefinitions).where(eq(attributeDefinitions.tenantId, context.tenantId)).orderBy(attributeDefinitions.position, attributeDefinitions.name)).map(view));
}

export async function createAttribute(context: StaffContext, input: AttributeDefinitionInput): Promise<AttributeView> {
  guardTeamWrite(context);
  try {
    return await withTenant(context.tenantId, async (transaction) => {
      const existing = await transaction.select({ id: attributeDefinitions.id }).from(attributeDefinitions).where(eq(attributeDefinitions.tenantId, context.tenantId));
      const [row] = await transaction.insert(attributeDefinitions).values({
        tenantId: context.tenantId, name: input.name, kind: input.kind, options: input.options, position: existing.length,
      }).returning();
      if (!row) throw new Error("Attribute insert returned no row");
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.attribute.created", outcome: "success",
        metadata: { attributeId: row.id, kind: input.kind },
      });
      return view(row);
    });
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw duplicateError("an attribute");
    throw error;
  }
}

export async function updateAttribute(context: StaffContext, attributeId: string, input: { name?: string | undefined; options?: string[] | undefined; version: number }): Promise<AttributeView> {
  guardTeamWrite(context);
  try {
    return await withTenant(context.tenantId, async (transaction) => {
      const [current] = await transaction.select().from(attributeDefinitions)
        .where(and(eq(attributeDefinitions.tenantId, context.tenantId), eq(attributeDefinitions.id, attributeId))).for("update").limit(1);
      if (!current) throw new ApiError(404, "attribute_not_found", "That attribute could not be found.");
      if (current.version !== input.version) throw new ApiError(409, "version_conflict", "Someone else changed this attribute. Reload and try again.");
      const isChoice = current.kind === "single" || current.kind === "multiple";
      if (input.options !== undefined && (!isChoice || input.options.length < 2)) throw new ApiError(400, "invalid_options", "Add at least two choices.");
      const [row] = await transaction.update(attributeDefinitions).set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.options !== undefined ? { options: input.options } : {}),
        version: current.version + 1, updatedAt: new Date(),
      }).where(and(eq(attributeDefinitions.tenantId, context.tenantId), eq(attributeDefinitions.id, attributeId))).returning();
      if (!row) throw new Error("Attribute update returned no row");
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.attribute.updated", outcome: "success", metadata: { attributeId },
      });
      return view(row);
    });
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === "23505") throw duplicateError("an attribute");
    throw error;
  }
}

export async function deleteAttribute(context: StaffContext, attributeId: string): Promise<{ deleted: true }> {
  guardTeamWrite(context);
  return withTenant(context.tenantId, async (transaction) => {
    const removed = await transaction.delete(attributeDefinitions).where(and(eq(attributeDefinitions.tenantId, context.tenantId), eq(attributeDefinitions.id, attributeId))).returning({ id: attributeDefinitions.id });
    if (removed.length === 0) throw new ApiError(404, "attribute_not_found", "That attribute could not be found.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.attribute.deleted", outcome: "success", metadata: { attributeId },
    });
    return { deleted: true as const };
  });
}

/** Each person's values, for the Attributes screen and for filters. */
export async function listPersonAttributes(context: StaffContext): Promise<PersonAttributesView[]> {
  guardOrgRead(context);
  if (context.preview) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const people = await transaction.select({ id: practitioners.id, name: practitioners.name }).from(practitioners)
      .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.isActive, true))).orderBy(practitioners.name);
    const values = await transaction.select().from(practitionerAttributes).where(eq(practitionerAttributes.tenantId, context.tenantId));
    return people.map((person) => ({
      practitionerId: person.id, name: person.name,
      values: Object.fromEntries(values.filter((entry) => entry.practitionerId === person.id).map((entry) => [entry.attributeId, entry.value])),
    }));
  });
}

export async function setPersonAttributes(context: StaffContext, practitionerId: string, input: PersonAttributesInput): Promise<PersonAttributesView> {
  guardTeamWrite(context);
  await withTenant(context.tenantId, async (transaction) => {
    const [person] = await transaction.select({ id: practitioners.id }).from(practitioners).where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, practitionerId))).limit(1);
    if (!person) throw new ApiError(404, "practitioner_not_found", "That person could not be found.");
    const ids = Object.keys(input.values);
    const definitions = ids.length === 0 ? [] : await transaction.select().from(attributeDefinitions)
      .where(and(eq(attributeDefinitions.tenantId, context.tenantId), inArray(attributeDefinitions.id, ids)));
    if (definitions.length !== ids.length) throw new ApiError(400, "attribute_not_found", "One of those attributes no longer exists.");
    for (const definition of definitions) {
      const value = input.values[definition.id];
      if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
        await transaction.delete(practitionerAttributes).where(and(eq(practitionerAttributes.tenantId, context.tenantId), eq(practitionerAttributes.practitionerId, practitionerId), eq(practitionerAttributes.attributeId, definition.id)));
        continue;
      }
      const checked = checkAttributeValue({ kind: definition.kind as AttributeKind, options: definition.options, name: definition.name }, value);
      await transaction.insert(practitionerAttributes).values({ tenantId: context.tenantId, practitionerId, attributeId: definition.id, value: checked })
        .onConflictDoUpdate({ target: [practitionerAttributes.tenantId, practitionerAttributes.practitionerId, practitionerAttributes.attributeId], set: { value: checked, updatedAt: new Date() } });
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.attribute.values_set", outcome: "success",
      metadata: { practitionerId, attributeIds: ids },
    });
  });
  return (await listPersonAttributes(context)).find((entry) => entry.practitionerId === practitionerId)!;
}
