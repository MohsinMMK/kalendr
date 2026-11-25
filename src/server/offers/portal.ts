import "server-only";

import { sql } from "drizzle-orm";

import { requireDatabase, withTenant } from "@/db/client";
import type { CustomerOffers } from "@/lib/offers-contracts";

import type { PatientAccount } from "../patient-auth";
import { loadCustomerOffers } from "./packages";

export interface PortalOffers {
  people: { clinicSlug: string; clinicName: string; patientId: string; name: string; offers: CustomerOffers }[];
}

/** The packages, balances, expiry dates and memberships of everyone on a customer's sign-in, across businesses. */
export async function getPortalOffers(account: PatientAccount): Promise<PortalOffers> {
  const rows = await requireDatabase().execute<{ tenant_id: string; clinic_slug: string; clinic_name: string; patient_id: string }>(sql`select * from kalendr_portal_people(${account.id})`);
  const people: PortalOffers["people"] = [];
  for (const row of rows) {
    await withTenant(row.tenant_id, async (transaction) => {
      const offers = await loadCustomerOffers(transaction, row.tenant_id, row.patient_id);
      if (offers.packages.length === 0 && offers.memberships.length === 0) return;
      const [patient] = await transaction.execute<{ first_name: string; last_name: string }>(sql`select first_name, last_name from patients where tenant_id = ${row.tenant_id} and id = ${row.patient_id}`);
      people.push({ clinicSlug: row.clinic_slug, clinicName: row.clinic_name, patientId: row.patient_id, name: `${patient?.first_name ?? ""} ${patient?.last_name ?? ""}`.trim(), offers });
    });
  }
  return { people };
}
