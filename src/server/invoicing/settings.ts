import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, serviceTaxRules, taxSettings } from "@/db/schema";
import type { ServiceTaxRuleInput, TaxSettingsInput, TaxSettingsView } from "@/lib/invoicing-contracts";
import type { TaxTreatment } from "@/lib/gst";

import { ApiError } from "../api-error";
import { isPreviewMode } from "../preview-repository";
import { requirePermission, type StaffContext } from "../staff-context";
import { drizzleRunner } from "../workflows/runner";
import { loadTaxSettings } from "./tax";

function refusePreview(context: StaffContext): void {
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Tax settings are not kept in the preview.");
}

async function view(context: StaffContext, transaction: Parameters<Parameters<typeof withTenant>[1]>[0]): Promise<TaxSettingsView> {
  const settings = await loadTaxSettings(drizzleRunner(transaction), context.tenantId);
  const rows = await transaction.execute<{ id: string; name: string; price_minor: number | null; treatment: TaxTreatment | null; rate_bps: number | null; sac_code: string | null }>(sql`
    select s.id, s.name, s.price_minor, r.treatment, r.rate_bps, r.sac_code
    from services s left join service_tax_rules r on r.tenant_id = s.tenant_id and r.service_id = s.id
    where s.tenant_id = ${context.tenantId} and s.is_active order by s.name
  `);
  return {
    registered: settings.registered, gstin: settings.gstin, legalName: settings.isDefault ? null : settings.legalName, address: settings.address, stateCode: settings.stateCode,
    pricesIncludeTax: settings.pricesIncludeTax, defaultTreatment: settings.defaultTreatment, defaultRateBps: settings.defaultRateBps, defaultSacCode: settings.defaultSacCode,
    confirmedAt: settings.confirmedAt?.toISOString() ?? null, isDefault: settings.isDefault, hint: settings.hint, version: settings.version,
    services: rows.map((row) => ({ serviceId: row.id, name: row.name, price: row.price_minor, treatment: row.treatment, rateBps: row.rate_bps === null ? null : Number(row.rate_bps), sacCode: row.sac_code })),
  };
}

export async function getTaxSettings(context: StaffContext): Promise<TaxSettingsView> {
  requirePermission(context, "invoices.issue");
  refusePreview(context);
  return withTenant(context.tenantId, (transaction) => view(context, transaction));
}

/** Saves how the business is registered. Saving with `confirm` records that the owner checked it with their accountant. */
export async function saveTaxSettings(context: StaffContext, input: TaxSettingsInput): Promise<TaxSettingsView> {
  requirePermission(context, "payments.settings");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [current] = await transaction.execute<{ version: number; confirmed_at: Date | null }>(sql`
      select version, confirmed_at from tax_settings where tenant_id = ${context.tenantId} for update`);
    if (current && input.version !== undefined && input.version !== current.version) throw new ApiError(409, "version_conflict", "Someone else changed the tax settings. Reload and try again.");
    if (!current && input.version) throw new ApiError(409, "version_conflict", "The tax settings changed. Reload and try again.");
    const confirmedAt = input.confirm ? new Date() : current?.confirmed_at ? new Date(current.confirmed_at) : null;
    const values = {
      registered: input.registered, gstin: input.registered ? input.gstin ?? null : null, legalName: input.legalName ?? null, address: input.address ?? null,
      stateCode: input.registered ? input.stateCode ?? null : input.stateCode ?? null, pricesIncludeTax: input.pricesIncludeTax,
      defaultTreatment: input.defaultTreatment, defaultRateBps: input.defaultTreatment === "taxable" ? input.defaultRateBps : 0, defaultSacCode: input.defaultSacCode ?? null,
      confirmedAt, confirmedByUserId: input.confirm ? context.userId : null,
    };
    if (current) {
      await transaction.execute(sql`
        update tax_settings set registered = ${values.registered}, gstin = ${values.gstin}, legal_name = ${values.legalName}, address = ${values.address}, state_code = ${values.stateCode},
          prices_include_tax = ${values.pricesIncludeTax}, default_treatment = ${values.defaultTreatment}, default_rate_bps = ${values.defaultRateBps},
          default_sac_code = ${values.defaultSacCode}, confirmed_at = ${values.confirmedAt ? values.confirmedAt.toISOString() : null}::timestamptz, confirmed_by_user_id = coalesce(${values.confirmedByUserId}, confirmed_by_user_id),
          version = version + 1, updated_at = now()
        where tenant_id = ${context.tenantId}`);
    } else {
      await transaction.insert(taxSettings).values({ tenantId: context.tenantId, ...values });
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "tax_settings.saved", outcome: "success",
      metadata: { registered: input.registered, treatment: input.defaultTreatment, confirmed: input.confirm },
    });
    return view(context, transaction);
  });
}

/** Sets one service's own treatment. Clearing it (`null`) puts the service back on the business default. */
export async function saveServiceTaxRule(context: StaffContext, input: ServiceTaxRuleInput | { serviceId: string; clear: true }): Promise<TaxSettingsView> {
  requirePermission(context, "payments.settings");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [service] = await transaction.execute<{ id: string }>(sql`select id from services where tenant_id = ${context.tenantId} and id = ${input.serviceId}`);
    if (!service) throw new ApiError(404, "service_not_found", "That service could not be found.");
    if ("clear" in input) {
      await transaction.execute(sql`delete from service_tax_rules where tenant_id = ${context.tenantId} and service_id = ${input.serviceId}`);
    } else {
      await transaction.insert(serviceTaxRules).values({
        tenantId: context.tenantId, serviceId: input.serviceId, treatment: input.treatment, rateBps: input.treatment === "taxable" ? input.rateBps : 0, sacCode: input.sacCode ?? null,
      }).onConflictDoUpdate({
        target: [serviceTaxRules.tenantId, serviceTaxRules.serviceId],
        set: { treatment: input.treatment, rateBps: input.treatment === "taxable" ? input.rateBps : 0, sacCode: input.sacCode ?? null, updatedAt: new Date() },
      });
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "service_tax_rule.saved", outcome: "success",
      metadata: { serviceId: input.serviceId, cleared: "clear" in input },
    });
    return view(context, transaction);
  });
}
