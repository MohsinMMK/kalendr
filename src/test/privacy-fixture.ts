import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

export interface TenantFixture {
  tenantId: string;
  slug: string;
  locationId: string;
  serviceId: string;
  practitionerId: string;
}

/** A business with one place, one service and one person to see, made as the table owner. */
export async function createTenant(owner: postgres.Sql, label: string, businessType = "healthcare"): Promise<TenantFixture> {
  const suffix = randomUUID().slice(0, 8);
  const slug = `privacy-${label}-${suffix}`;
  const [tenant] = await owner<{ id: string }[]>`
    insert into tenants (slug, name, legal_name, phone, email, timezone, business_type)
    values (${slug}, ${`Privacy ${label}`}, ${`Privacy ${label} LLP`}, '+919800000000', ${`owner-${slug}@example.com`}, 'Asia/Kolkata', ${businessType})
    returning id`;
  const tenantId = tenant!.id;
  const [location] = await owner<{ id: string }[]>`
    insert into locations (tenant_id, name, address, city, timezone) values (${tenantId}, 'Main', '1 Test Road', 'Pune', 'Asia/Kolkata') returning id`;
  const [service] = await owner<{ id: string }[]>`
    insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types)
    values (${tenantId}, 'Check-up', 'A check-up', 30, 'instant', ${["new", "returning"]}) returning id`;
  const [practitioner] = await owner<{ id: string }[]>`
    insert into practitioners (tenant_id, name, title, initials, specialty) values (${tenantId}, 'Dr Test', 'Doctor', 'DT', 'General') returning id`;
  return { tenantId, slug, locationId: location!.id, serviceId: service!.id, practitionerId: practitioner!.id };
}

export interface CustomerOptions {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  dateOfBirth?: string | null;
  isDependent?: boolean;
}

export async function createCustomer(owner: postgres.Sql, tenantId: string, options: CustomerOptions = {}): Promise<{ id: string; firstName: string; lastName: string; phone: string; email: string }> {
  const unique = randomUUID().slice(0, 8);
  const firstName = options.firstName ?? `Zephyrine${unique}`;
  const lastName = options.lastName ?? `Quillfeather${unique}`;
  const phone = options.phone ?? `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const email = options.email ?? `${firstName}.${lastName}@example.com`.toLowerCase();
  const [row] = await owner<{ id: string }[]>`
    insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel, date_of_birth, is_dependent)
    values (${tenantId}, ${firstName}, ${lastName}, ${phone}, ${email}, 'email', ${options.dateOfBirth ?? "1985-04-12"}, ${options.isDependent ?? false})
    returning id`;
  return { id: row!.id, firstName, lastName, phone, email };
}

export async function createBooking(
  owner: postgres.Sql,
  fixture: TenantFixture,
  patientId: string,
  options: { notes?: string | null; status?: string; endsDaysAgo?: number } = {},
): Promise<string> {
  const daysAgo = options.endsDaysAgo ?? 1;
  const [row] = await owner<{ id: string }[]>`
    insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source,
      manage_token_hash, notes, reason_for_visit, price_minor)
    values (${fixture.tenantId}, ${fixture.locationId}, ${patientId}, ${fixture.practitionerId}, ${fixture.serviceId},
      now() - ${daysAgo} * interval '1 day' - interval '30 minutes', now() - ${daysAgo} * interval '1 day',
      ${options.status ?? "completed"}, 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")},
      ${options.notes ?? null}, ${options.notes ? "Follow-up visit" : null}, 50000)
    returning id`;
  return row!.id;
}

/**
 * The worker-only functions must not be callable by the web app's role. The release scripts revoke them; a database set
 * up with a blanket function grant (a shared test server) needs the same step, which the table owner can take.
 */
export async function revokeWorkerOnlyFunctions(owner: postgres.Sql, runtime: postgres.Sql): Promise<void> {
  const [row] = await runtime<{ role: string }[]>`select current_user as role`;
  await owner.unsafe(`revoke execute on function kalendr_erase_consent_records(text, text), kalendr_scrub_audit_personal(text, text[]),
    kalendr_breach_affected(timestamptz, timestamptz) from "${row!.role.replaceAll('"', "")}"`);
}

/** An owner-level staff context with a fresh second-factor check, so step-up passes. */
export function staffContext(fixture: TenantFixture, overrides: Partial<StaffContext> = {}): StaffContext {
  return {
    tenantId: fixture.tenantId,
    clinicSlug: fixture.slug,
    clinicName: "Privacy test",
    role: "owner",
    permissions: resolvePermissions("owner", {}),
    membershipId: null,
    userId: `user-${randomUUID().slice(0, 8)}`,
    userName: "Owner",
    userEmail: "owner@example.com",
    secondFactorEnrolled: true,
    secondFactorAt: new Date(),
    preview: false,
    ...overrides,
  };
}
