import { profileWords, resolveBusinessProfile } from "../../lib/terminology";
import type { MessageWords } from "../policy";
import type { TenantDb } from "./types";

/** The business's own words for customer messages, read from its type and renamed words. */
export async function tenantWords(tenantDb: TenantDb, tenantId: string): Promise<MessageWords> {
  const rows = await tenantDb`
    select business_type, terminology, features from tenants where id = ${tenantId}
  `;
  const tenant = rows[0] as { business_type: string; terminology: unknown; features: unknown } | undefined;
  return profileWords(resolveBusinessProfile({
    businessType: tenant?.business_type ?? "",
    terminology: tenant?.terminology,
    features: tenant?.features,
  }));
}
