import "server-only";

import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import type { AttributeInfo, DirectoryPerson, RoutingDefinition } from "@/lib/routing-forms";

import { jsonValue } from "./json";

/** The service ids a form sends people to, across its routes and its fallback. */
export function destinationServiceIds(definition: RoutingDefinition): string[] {
  const ids = new Set<string>();
  for (const route of definition.routes) if (route.destination.type === "service") ids.add(route.destination.serviceId);
  if (definition.fallback.type === "service") ids.add(definition.fallback.serviceId);
  return [...ids];
}

export interface ServiceFacts {
  id: string;
  name: string;
  active: boolean;
  hidden: boolean;
}

export interface Directory {
  /** For each service: the active people who offer it, with their attributes. Empty for a missing or inactive service. */
  byService: Map<string, DirectoryPerson[]>;
  attributes: AttributeInfo[];
  services: Map<string, ServiceFacts>;
}

const list = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/**
 * Who could be offered for each service, read without taking any lock. The booking itself locks and re-checks inside its
 * own transaction; this is what the form, the preview and the builder's checks look at.
 */
export async function loadDirectory(transaction: KalendrTransaction, tenantId: string, serviceIds: readonly string[]): Promise<Directory> {
  const attributes = (await transaction.execute<{ id: string; name: string }>(sql`
    select id, name from attribute_definitions where tenant_id = ${tenantId} order by position, name
  `)).map((row) => ({ id: row.id, name: row.name }));
  const services = new Map<string, ServiceFacts>();
  const byService = new Map<string, DirectoryPerson[]>();
  if (serviceIds.length === 0) return { byService, attributes, services };

  for (const row of await transaction.execute<{ id: string; name: string; is_active: boolean; visibility: string }>(sql`
    select id, name, is_active, visibility from services where tenant_id = ${tenantId} and id in (${list(serviceIds)})
  `)) {
    services.set(row.id, { id: row.id, name: row.name, active: row.is_active, hidden: row.visibility === "hidden" });
  }
  const people = await transaction.execute<{ service_id: string; id: string; name: string }>(sql`
    select practitioner_service.service_id, practitioner.id, practitioner.name
    from practitioner_services as practitioner_service
    join practitioners as practitioner on practitioner.tenant_id = practitioner_service.tenant_id and practitioner.id = practitioner_service.practitioner_id and practitioner.is_active
    join services as service on service.tenant_id = practitioner_service.tenant_id and service.id = practitioner_service.service_id and service.is_active
    where practitioner_service.tenant_id = ${tenantId} and practitioner_service.service_id in (${list(serviceIds)})
    order by practitioner.name, practitioner.id
  `);
  const personIds = [...new Set(people.map((person) => person.id))];
  const values = personIds.length === 0 ? [] : await transaction.execute<{ practitioner_id: string; attribute_id: string; value: string | number | string[] }>(sql`
    select practitioner_id, attribute_id, value from practitioner_attributes
    where tenant_id = ${tenantId} and practitioner_id in (${list(personIds)})
  `);
  const attributesOf = new Map<string, Record<string, string | number | string[]>>();
  for (const row of values) {
    const mine = attributesOf.get(row.practitioner_id) ?? {};
    mine[row.attribute_id] = jsonValue(row.value) as string | number | string[];
    attributesOf.set(row.practitioner_id, mine);
  }
  for (const row of people) {
    const entry = byService.get(row.service_id) ?? [];
    entry.push({ id: row.id, name: row.name, attributes: attributesOf.get(row.id) ?? {} });
    byService.set(row.service_id, entry);
  }
  return { byService, attributes, services };
}
