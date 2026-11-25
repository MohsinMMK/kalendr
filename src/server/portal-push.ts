import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { requireDatabase, withTenant } from "@/db/client";
import { pushSubscriptions } from "@/db/schema";
import { PUSH_SECRET_PURPOSE, pushSubscriptionInputSchema } from "@/lib/staff-alerts";

import { loadRecordKeys } from "./record-crypto";
import { sealSecret, secretKeyVersion } from "./keys/secrets";
import type { PatientAccount } from "./patient-auth";
import { endpointHash } from "./staff-notifications";

interface PersonRow extends Record<string, unknown> {
  tenant_id: string;
  patient_id: string;
}

/** Every customer record this portal sign-in belongs to, one or more per business. */
async function peopleOf(account: PatientAccount): Promise<PersonRow[]> {
  return requireDatabase().execute<PersonRow>(sql`select tenant_id, patient_id from kalendr_portal_people(${account.id})`);
}

/**
 * Saves this browser's push address for the customer, under each business that knows them, so any of those
 * businesses can send a free reminder. Sealed like staff addresses.
 */
export async function savePortalPush(account: PatientAccount, input: z.infer<typeof pushSubscriptionInputSchema>): Promise<{ saved: number }> {
  const people = await peopleOf(account);
  const payload = JSON.stringify({ endpoint: input.endpoint, keys: input.keys });
  let saved = 0;
  for (const person of people) {
    await withTenant(person.tenant_id, async (transaction) => {
      await loadRecordKeys(transaction, person.tenant_id, { forWrite: true });
      const sealed = sealSecret(person.tenant_id, PUSH_SECRET_PURPOSE, payload);
      const values = { subscriptionCiphertext: sealed, keyVersion: secretKeyVersion(sealed) };
      await transaction.insert(pushSubscriptions).values({
        tenantId: person.tenant_id, ownerType: "customer", patientId: person.patient_id, endpointHash: endpointHash(input.endpoint), ...values,
      }).onConflictDoUpdate({
        target: [pushSubscriptions.tenantId, pushSubscriptions.endpointHash],
        set: { ...values, patientId: person.patient_id, membershipId: null, ownerType: "customer" },
      });
    });
    saved += 1;
  }
  return { saved };
}

export async function removePortalPush(account: PatientAccount, endpoint: string): Promise<{ removed: number }> {
  const people = await peopleOf(account);
  let removed = 0;
  for (const person of people) {
    const rows = await withTenant(person.tenant_id, (transaction) => transaction.delete(pushSubscriptions).where(and(
      eq(pushSubscriptions.tenantId, person.tenant_id),
      eq(pushSubscriptions.patientId, person.patient_id),
      eq(pushSubscriptions.endpointHash, endpointHash(endpoint)),
    )).returning({ id: pushSubscriptions.id }));
    removed += rows.length;
  }
  return { removed };
}
