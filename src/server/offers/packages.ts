import "server-only";

import { addDays } from "date-fns";
import { sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction as TenantTransaction } from "@/db/client";
import { auditEvents } from "@/db/schema";
import type { AdjustCreditsInput, CreditEntryView, CustomerOffers, CustomerPackageView, PackageInput, PackageView, SellPackageInput } from "@/lib/offers-contracts";
import { graceEndsAt, membershipBenefitsOn, type MembershipStatus } from "@/lib/offers";

import { textArray } from "./sql";
import { ApiError } from "../api-error";
import { loadVisibleCustomer } from "../customers/access";
import { assertAppointmentVisibleHere, assertLocationAllowed, customerVisibleHere } from "../location-scope";
import { claimKey, finishKey } from "../idempotent";
import { insertInvoice } from "../invoicing/issue-core";
import { defaultServiceTax, loadTaxSettings } from "../invoicing/tax";
import { isPreviewMode } from "../preview-repository";
import { requirePermission, type StaffContext } from "../staff-context";
import { asDate, asNumber, drizzleRunner } from "../workflows/runner";
import { lockPackage, redeemCredit } from "./credits-core";

function refusePreview(context: StaffContext): void {
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Packages are not kept in the preview.");
}

async function assertServices(transaction: TenantTransaction, tenantId: string, serviceIds: string[]): Promise<void> {
  const found = await transaction.execute<{ id: string }>(sql`select id from services where tenant_id = ${tenantId} and id = any (${textArray(serviceIds)})`);
  if (found.length !== new Set(serviceIds).size) throw new ApiError(404, "service_not_found", "One of those services could not be found.");
}

async function currencyOf(transaction: TenantTransaction, tenantId: string): Promise<string> {
  const [tenant] = await transaction.execute<{ currency: string }>(sql`select currency from tenants where id = ${tenantId}`);
  return tenant?.currency ?? "INR";
}

type PackageRow = { id: string; name: string; description: string | null; price_minor: number; credits: number; valid_days: number; service_ids: string[]; is_active: boolean; version: number; sold: number | string; outstanding: number | string };

function packageView(row: PackageRow, currency: string): PackageView {
  return {
    id: row.id, name: row.name, description: row.description, priceMinor: asNumber(row.price_minor), currency, credits: asNumber(row.credits), validDays: asNumber(row.valid_days),
    serviceIds: row.service_ids, isActive: row.is_active, version: asNumber(row.version), sold: asNumber(row.sold), creditsOutstanding: asNumber(row.outstanding),
  };
}

export async function listPackages(context: StaffContext): Promise<PackageView[]> {
  requirePermission(context, "schedule.read");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const currency = await currencyOf(transaction, context.tenantId);
    const rows = await transaction.execute<PackageRow>(sql`
      select p.id, p.name, p.description, p.price_minor, p.credits, p.valid_days, p.service_ids, p.is_active, p.version,
        (select count(*) from customer_packages cp where cp.tenant_id = p.tenant_id and cp.package_id = p.id) as sold,
        (select coalesce(sum(c."change"), 0) from customer_credits c join customer_packages cp on cp.tenant_id = c.tenant_id and cp.id = c.customer_package_id
          where cp.tenant_id = p.tenant_id and cp.package_id = p.id) as outstanding
      from packages p where p.tenant_id = ${context.tenantId} order by p.is_active desc, p.name`);
    return rows.map((row) => packageView(row, currency));
  });
}

/** Creates a package (no id) or edits one. Packages already sold keep what they were sold as. */
export async function savePackage(context: StaffContext, packageId: string | null, input: PackageInput): Promise<PackageView> {
  requirePermission(context, "payments.settings");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    await assertServices(transaction, context.tenantId, input.serviceIds);
    let id = packageId;
    if (packageId) {
      const updated = await transaction.execute<{ id: string }>(sql`
        update packages set name = ${input.name}, description = ${input.description ?? null}, price_minor = ${input.priceMinor}, credits = ${input.credits}, valid_days = ${input.validDays},
          service_ids = ${textArray(input.serviceIds)}, is_active = ${input.isActive}, version = version + 1, updated_at = now()
        where tenant_id = ${context.tenantId} and id = ${packageId} and (${input.version ?? null}::int is null or version = ${input.version ?? null}::int) returning id`);
      if (updated.length === 0) {
        const [exists] = await transaction.execute<{ id: string }>(sql`select id from packages where tenant_id = ${context.tenantId} and id = ${packageId}`);
        throw exists ? new ApiError(409, "version_conflict", "Someone else changed this package. Reload and try again.") : new ApiError(404, "package_not_found", "That package could not be found.");
      }
    } else {
      const [created] = await transaction.execute<{ id: string }>(sql`
        insert into packages (tenant_id, name, description, price_minor, credits, valid_days, service_ids, is_active)
        values (${context.tenantId}, ${input.name}, ${input.description ?? null}, ${input.priceMinor}, ${input.credits}, ${input.validDays}, ${textArray(input.serviceIds)}, ${input.isActive}) returning id`);
      id = created!.id;
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: packageId ? "package.updated" : "package.created", outcome: "success",
      metadata: { packageId: id, priceMinor: input.priceMinor, credits: input.credits },
    });
    const currency = await currencyOf(transaction, context.tenantId);
    const [row] = await transaction.execute<PackageRow>(sql`
      select p.id, p.name, p.description, p.price_minor, p.credits, p.valid_days, p.service_ids, p.is_active, p.version, 0 as sold, 0 as outstanding
      from packages p where p.tenant_id = ${context.tenantId} and p.id = ${id}`);
    return packageView(row!, currency);
  });
}

// --- A customer's packages ---------------------------------------------------------------------------------------

type HeldRow = { id: string; patient_id: string; source: "package" | "membership" | "gift"; name: string; credits_total: number; bought_at: Date; expires_at: Date; service_ids: string[]; invoice_id: string | null; remaining: number | string };

export async function loadCustomerPackages(transaction: TenantTransaction, tenantId: string, patientId: string, now = new Date()): Promise<CustomerPackageView[]> {
  const rows = await transaction.execute<HeldRow>(sql`
    select cp.id, cp.patient_id, cp.source, cp.name, cp.credits_total, cp.bought_at, cp.expires_at, cp.service_ids, cp.invoice_id,
      (select coalesce(sum(c."change"), 0) from customer_credits c where c.tenant_id = cp.tenant_id and c.customer_package_id = cp.id) as remaining
    from customer_packages cp where cp.tenant_id = ${tenantId} and cp.patient_id = ${patientId} order by cp.expires_at desc, cp.id limit 100`);
  const ids = rows.map((row) => row.id);
  const ledger = ids.length === 0 ? [] : await transaction.execute<{ id: string; customer_package_id: string; change: number; kind: CreditEntryView["kind"]; reason: string; appointment_id: string | null; created_at: Date }>(sql`
    select id, customer_package_id, "change", kind, reason, appointment_id, created_at from customer_credits
    where tenant_id = ${tenantId} and customer_package_id = any (${textArray(ids)}) order by created_at, id`);
  return rows.map((row) => {
    const remaining = asNumber(row.remaining);
    const expiresAt = asDate(row.expires_at);
    return {
      id: row.id, patientId: row.patient_id, name: row.name, source: row.source, creditsTotal: asNumber(row.credits_total), remaining, boughtAt: asDate(row.bought_at).toISOString(),
      expiresAt: expiresAt.toISOString(), status: remaining > 0 && expiresAt > now ? "active" : expiresAt <= now ? "expired" : "used_up", serviceIds: row.service_ids, invoiceId: row.invoice_id,
      ledger: ledger.filter((entry) => entry.customer_package_id === row.id).map((entry): CreditEntryView => ({
        id: entry.id, change: asNumber(entry.change), kind: entry.kind, reason: entry.reason, appointmentId: entry.appointment_id, at: asDate(entry.created_at).toISOString(),
      })),
    };
  });
}

/** What the customer profile (and the portal) shows: packages with balances and expiry, and memberships. */
export async function loadCustomerOffers(transaction: TenantTransaction, tenantId: string, patientId: string, now = new Date()): Promise<CustomerOffers> {
  const memberships = await transaction.execute<{ id: string; patient_id: string; plan_id: string; plan_name: string; status: MembershipStatus; current_period_end: Date; past_due_since: Date | null }>(sql`
    select m.id, m.patient_id, m.plan_id, p.name as plan_name, m.status, m.current_period_end, m.past_due_since
    from customer_memberships m join membership_plans p on p.tenant_id = m.tenant_id and p.id = m.plan_id
    where m.tenant_id = ${tenantId} and m.patient_id = ${patientId} order by m.started_at desc`);
  return {
    packages: await loadCustomerPackages(transaction, tenantId, patientId, now),
    memberships: memberships.map((row) => {
      const since = row.past_due_since ? asDate(row.past_due_since) : null;
      return {
        id: row.id, patientId: row.patient_id, planId: row.plan_id, planName: row.plan_name, status: row.status, currentPeriodEnd: asDate(row.current_period_end).toISOString(),
        benefitsOn: membershipBenefitsOn(row.status, since, now), graceEndsAt: row.status === "past_due" && since ? graceEndsAt(since).toISOString() : null,
      };
    }),
  };
}

export async function getCustomerOffers(context: StaffContext, patientId: string): Promise<CustomerOffers> {
  requirePermission(context, "schedule.read");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const [patient] = await transaction.execute<{ id: string }>(sql`select id from patients where tenant_id = ${context.tenantId} and id = ${patientId}`);
    if (!patient) throw new ApiError(404, "patient_not_found", "That customer could not be found.");
    // A practitioner sees the offers of customers they have seen, like the rest of the customer's profile.
    if (context.role === "practitioner") {
      const [own] = await transaction.execute<{ id: string }>(sql`
        select appointment.id from appointments as appointment
        join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
        where appointment.tenant_id = ${context.tenantId} and appointment.patient_id = ${patientId} and practitioner.auth_user_id = ${context.userId}
        limit 1`);
      if (!own) throw new ApiError(404, "patient_not_found", "That customer could not be found.");
    }
    if (!(await customerVisibleHere(transaction, context, patientId))) throw new ApiError(404, "patient_not_found", "That customer could not be found.");
    return loadCustomerOffers(transaction, context.tenantId, patientId);
  });
}

/**
 * Sells a package at the desk: one invoice, the payments taken (split across methods, part payment allowed) and one `+N`
 * ledger row, in a single transaction. Paying online for a package is not built yet.
 */
export async function sellPackage(context: StaffContext, input: SellPackageInput, idempotencyKey: string): Promise<CustomerPackageView> {
  requirePermission(context, "payments.collect");
  requirePermission(context, "invoices.issue");
  refusePreview(context);
  // Selling at a location the person may not use is refused up front, like booking there.
  assertLocationAllowed(context, input.locationId);
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<CustomerPackageView>(transaction, context.tenantId, "staff.packages.sell", idempotencyKey, input);
    if ("replay" in claim) return claim.replay;
    const [pack] = await transaction.execute<{ id: string; name: string; price_minor: number; credits: number; valid_days: number; service_ids: string[]; is_active: boolean }>(sql`
      select id, name, price_minor, credits, valid_days, service_ids, is_active from packages where tenant_id = ${context.tenantId} and id = ${input.packageId}`);
    if (!pack) throw new ApiError(404, "package_not_found", "That package could not be found.");
    if (!pack.is_active) throw new ApiError(409, "package_inactive", "This package is no longer on sale.");
    // A customer hidden from this person (other branch, or a practitioner's non-patient) reads as missing.
    await loadVisibleCustomer(transaction, context, input.patientId);
    const [patient] = await transaction.execute<{ first_name: string; last_name: string }>(sql`select first_name, last_name from patients where tenant_id = ${context.tenantId} and id = ${input.patientId} for key share`);
    if (!patient) throw new ApiError(404, "patient_not_found", "That customer could not be found.");
    const [place] = await transaction.execute<{ id: string }>(sql`select id from locations where tenant_id = ${context.tenantId} and id = ${input.locationId}`);
    if (!place) throw new ApiError(404, "location_not_found", "That location could not be found.");
    const price = asNumber(pack.price_minor);
    const paid = input.payments.reduce((total, payment) => total + payment.amountMinor, 0);
    if (paid > price) throw new ApiError(409, "payment_exceeds_due", "That is more than the package costs.");
    const run = drizzleRunner(transaction);
    const settings = await loadTaxSettings(run, context.tenantId);
    if (input.buyerGstin && !settings.registered) throw new ApiError(409, "not_registered", "Turn on GST in the tax settings before adding a customer's GSTIN.");
    const now = new Date();
    const invoice = await insertInvoice(run, {
      tenantId: context.tenantId, patientId: input.patientId, locationId: input.locationId, source: "package", description: pack.name, unitPriceMinor: price,
      tax: defaultServiceTax(settings), pricesIncludeTax: settings.pricesIncludeTax, settings,
      buyer: { name: `${patient.first_name} ${patient.last_name}`.trim(), gstin: input.buyerGstin ?? null, stateCode: input.buyerStateCode ?? null }, issuedByUserId: context.userId, issuedAt: now,
    });
    const [held] = await transaction.execute<{ id: string }>(sql`
      insert into customer_packages (tenant_id, patient_id, package_id, source, name, credits_total, price_minor, service_ids, bought_at, expires_at, invoice_id, sold_by_user_id)
      values (${context.tenantId}, ${input.patientId}, ${pack.id}, 'package', ${pack.name}, ${pack.credits}, ${price}, ${textArray(pack.service_ids)}, ${now.toISOString()}::timestamptz,
        ${addDays(now, asNumber(pack.valid_days)).toISOString()}::timestamptz, ${invoice.id}, ${context.userId}) returning id`);
    await transaction.execute(sql`
      insert into customer_credits (tenant_id, customer_package_id, "change", kind, reason, actor_user_id)
      values (${context.tenantId}, ${held!.id}, ${pack.credits}, 'purchase', 'Package bought', ${context.userId})`);
    for (const payment of input.payments) {
      await transaction.execute(sql`
        insert into payments (tenant_id, patient_id, location_id, invoice_id, amount_minor, currency, method, recorded_by_user_id)
        values (${context.tenantId}, ${input.patientId}, ${input.locationId}, ${invoice.id}, ${payment.amountMinor}, ${invoice.currency}, ${payment.method}, ${context.userId})`);
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "package.sold", outcome: "success",
      metadata: { customerPackageId: held!.id, packageId: pack.id, invoiceId: invoice.id, totalMinor: price, paidMinor: paid, credits: pack.credits },
    });
    const [view] = (await loadCustomerPackages(transaction, context.tenantId, input.patientId)).filter((entry) => entry.id === held!.id);
    await finishKey(transaction, claim.claimId, view);
    return view!;
  });
}

/** Adds or takes away credits by hand, with a reason. A balance can never go below zero. */
export async function adjustCredits(context: StaffContext, customerPackageId: string, input: AdjustCreditsInput, idempotencyKey: string): Promise<CustomerPackageView> {
  requirePermission(context, "payments.refund");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<CustomerPackageView>(transaction, context.tenantId, "staff.packages.adjust", idempotencyKey, { customerPackageId, ...input });
    if ("replay" in claim) return claim.replay;
    const run = drizzleRunner(transaction);
    const held = await lockPackage(run, context.tenantId, customerPackageId);
    if (!held) throw new ApiError(404, "package_not_found", "That package could not be found.");
    // A package held by a customer this person can't see reads as missing.
    await loadVisibleCustomer(transaction, context, held.patientId, { allowMerged: true });
    if (held.remaining + input.change < 0) throw new ApiError(409, "no_credits", `This package only has ${held.remaining} credit${held.remaining === 1 ? "" : "s"} left.`);
    await transaction.execute(sql`
      insert into customer_credits (tenant_id, customer_package_id, "change", kind, reason, actor_user_id)
      values (${context.tenantId}, ${customerPackageId}, ${input.change}, 'adjust', ${input.reason}, ${context.userId})`);
    // The reason is free text, so it stays out of the activity log.
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "package.credits_adjusted", outcome: "success", metadata: { customerPackageId, change: input.change },
    });
    const [view] = (await loadCustomerPackages(transaction, context.tenantId, held.patientId)).filter((entry) => entry.id === customerPackageId);
    await finishKey(transaction, claim.claimId, view);
    return view!;
  });
}

/** Pays an existing booking with a credit, at the desk: the booking becomes free and one credit is spent. */
export async function spendCreditOnAppointment(context: StaffContext, appointmentId: string, customerPackageId: string, idempotencyKey: string): Promise<CustomerPackageView> {
  requirePermission(context, "appointments.book");
  refusePreview(context);
  return withTenant(context.tenantId, async (transaction) => {
    const claim = await claimKey<CustomerPackageView>(transaction, context.tenantId, "staff.packages.use", idempotencyKey, { appointmentId, customerPackageId });
    if ("replay" in claim) return claim.replay;
    const [visit] = await transaction.execute<{ id: string; patient_id: string; service_id: string; status: string; price_minor: number | null }>(sql`
      select id, patient_id, service_id, status::text as status, price_minor from appointments where tenant_id = ${context.tenantId} and id = ${appointmentId} for update`);
    if (!visit) throw new ApiError(404, "appointment_not_found", "That visit could not be found.");
    await assertAppointmentVisibleHere(transaction, context, appointmentId);
    if (!["booked", "checked_in", "completed", "requested"].includes(visit.status)) throw new ApiError(409, "not_payable", "A credit can only be used on a visit that is still going ahead.");
    const price = visit.price_minor ?? 0;
    if (price <= 0) throw new ApiError(409, "nothing_to_discount", "This visit is free, so a credit isn't needed.");
    const [paid] = await transaction.execute<{ total: string }>(sql`select coalesce(sum(amount_minor), 0) as total from payments where tenant_id = ${context.tenantId} and appointment_id = ${appointmentId}`);
    if (asNumber(paid?.total) > 0) throw new ApiError(409, "already_paid", "Money has already been taken for this visit. Refund it first, then use the credit.");
    const [invoiced] = await transaction.execute<{ n: number }>(sql`select count(*)::int as n from invoices where tenant_id = ${context.tenantId} and appointment_id = ${appointmentId}`);
    if (asNumber(invoiced?.n) > 0) throw new ApiError(409, "already_invoiced", "This visit has an invoice. Issue a credit note for it first.");
    const [discount] = await transaction.execute<{ kind: string }>(sql`select kind from appointment_discounts where tenant_id = ${context.tenantId} and appointment_id = ${appointmentId}`);
    if (discount) throw new ApiError(409, "one_discount", "This visit already has a discount. A visit takes one.");
    const result = await redeemCredit(drizzleRunner(transaction), {
      tenantId: context.tenantId, customerPackageId, patientId: visit.patient_id, appointmentId, serviceId: visit.service_id, actorUserId: context.userId, now: new Date(),
    });
    if (result.status === "used") {
      await transaction.execute(sql`
        insert into appointment_discounts (tenant_id, appointment_id, kind, list_price_minor, amount_minor, customer_package_id)
        values (${context.tenantId}, ${appointmentId}, 'package', ${price}, ${price}, ${customerPackageId})`);
      await transaction.execute(sql`update appointments set price_minor = 0, updated_at = now() where tenant_id = ${context.tenantId} and id = ${appointmentId}`);
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, appointmentId, actorUserId: context.userId, actorType: "staff", action: "package.credit_used", outcome: "success", metadata: { customerPackageId, priceMinor: price },
      });
    }
    const [view] = (await loadCustomerPackages(transaction, context.tenantId, visit.patient_id)).filter((entry) => entry.id === customerPackageId);
    await finishKey(transaction, claim.claimId, view);
    return view!;
  });
}

