import { sql } from "drizzle-orm";

import { defaultTaxFor, HEALTH_EXEMPTION_NOTE, type TaxTreatment } from "../../lib/gst";
import { asNumber, asString, type Runner } from "../workflows/runner";

export interface EffectiveTaxSettings {
  registered: boolean;
  gstin: string | null;
  legalName: string;
  address: string | null;
  stateCode: string | null;
  pricesIncludeTax: boolean;
  defaultTreatment: TaxTreatment;
  defaultRateBps: number;
  defaultSacCode: string | null;
  confirmedAt: Date | null;
  version: number;
  /** Nothing saved yet: these are the defaults offered for the business type. */
  isDefault: boolean;
  businessType: string;
  hint: string;
  currency: string;
  timezone: string;
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/** What invoices use for this business: its saved settings, or the offered defaults for its type until it saves some. */
export async function loadTaxSettings(run: Runner, tenantId: string): Promise<EffectiveTaxSettings> {
  const [tenant] = await run(sql`select legal_name, business_type, currency, timezone from tenants where id = ${tenantId}`);
  if (!tenant) throw new Error("Business not found");
  const businessType = asString(tenant.business_type);
  const offered = defaultTaxFor(businessType);
  const [saved] = await run(sql`select * from tax_settings where tenant_id = ${tenantId}`);
  const common = { businessType, hint: offered.hint, currency: asString(tenant.currency), timezone: asString(tenant.timezone) };
  if (!saved) {
    return {
      registered: false, gstin: null, legalName: asString(tenant.legal_name), address: null, stateCode: null, pricesIncludeTax: true,
      defaultTreatment: offered.treatment, defaultRateBps: offered.rateBps, defaultSacCode: offered.sacCode, confirmedAt: null, version: 0, isDefault: true, ...common,
    };
  }
  return {
    registered: saved.registered === true, gstin: text(saved.gstin), legalName: text(saved.legal_name) ?? asString(tenant.legal_name), address: text(saved.address), stateCode: text(saved.state_code),
    pricesIncludeTax: saved.prices_include_tax === true, defaultTreatment: asString(saved.default_treatment) as TaxTreatment, defaultRateBps: asNumber(saved.default_rate_bps),
    defaultSacCode: text(saved.default_sac_code), confirmedAt: saved.confirmed_at ? new Date(asString(saved.confirmed_at)) : null, version: asNumber(saved.version), isDefault: false, ...common,
  };
}

export interface ServiceTax {
  treatment: TaxTreatment;
  rateBps: number;
  sacCode: string | null;
  exemptionNote: string | null;
}

export function exemptionNoteFor(treatment: TaxTreatment, businessType: string): string | null {
  if (treatment === "taxable") return null;
  if (treatment === "nil") return "Nil-rated supply.";
  return businessType === "healthcare" || businessType === "dental" ? HEALTH_EXEMPTION_NOTE : "Exempt from GST.";
}

/** The business default, for things sold without a service of their own, like a package. */
export function defaultServiceTax(settings: EffectiveTaxSettings): ServiceTax {
  return { treatment: settings.defaultTreatment, rateBps: settings.defaultRateBps, sacCode: settings.defaultSacCode, exemptionNote: exemptionNoteFor(settings.defaultTreatment, settings.businessType) };
}

/** The service's own rule, or the business default. */
export async function serviceTax(run: Runner, tenantId: string, serviceId: string, settings: EffectiveTaxSettings): Promise<ServiceTax> {
  const [rule] = await run(sql`select treatment, rate_bps, sac_code from service_tax_rules where tenant_id = ${tenantId} and service_id = ${serviceId}`);
  if (!rule) return defaultServiceTax(settings);
  const treatment = asString(rule.treatment) as TaxTreatment;
  return { treatment, rateBps: asNumber(rule.rate_bps), sacCode: text(rule.sac_code), exemptionNote: exemptionNoteFor(treatment, settings.businessType) };
}
