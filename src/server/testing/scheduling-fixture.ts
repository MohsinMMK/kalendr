import { randomUUID } from "node:crypto";

import postgres from "postgres";

import type { PublicBookingInput } from "@/lib/contracts";
import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

/**
 * A throwaway person, service and weekly hours inside the seeded `lotus-dental` business, for scheduling
 * integration tests. Every row it makes is removed by `cleanup`. Test code only.
 */
export interface SchedulingFixture {
  owner: postgres.Sql;
  tenantId: string;
  otherTenantId: string;
  locationId: string;
  practitionerId: string;
  serviceId: string;
  context: StaffContext;
  outsider: StaffContext;
  slug: string;
  cleanup(): Promise<void>;
  /** A booking request body for a start time and email. */
  bookingInput(startsAt: string, endsAt: string, email: string, extra?: Partial<PublicBookingInput>): PublicBookingInput;
}

export interface FixtureOptions {
  name: string;
  /** Extra columns for the service row, as SQL column assignments through the postgres.js helper. */
  service?: Record<string, string | number | boolean | null>;
  /** Minutes per slot. */
  durationMinutes?: number;
}

export async function createSchedulingFixture(ownerUrl: string, options: FixtureOptions): Promise<SchedulingFixture> {
  const owner = postgres(ownerUrl, { max: 2, prepare: false });
  const slug = "lotus-dental";
  const practitionerId = randomUUID();
  const serviceId = randomUUID();
  const [tenant] = await owner<{ id: string; name: string }[]>`select id, name from tenants where slug = ${slug} limit 1`;
  const [other] = await owner<{ id: string; slug: string; name: string }[]>`select id, slug, name from tenants where slug <> ${slug} limit 1`;
  if (!tenant || !other) throw new Error("Seed the isolated local database before this test");
  const [location] = await owner<{ id: string; timezone: string }[]>`select id, timezone from locations where tenant_id = ${tenant.id} limit 1`;
  if (!location) throw new Error("The seeded business has no location");
  const [membership] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenant.id} and role = 'owner' limit 1`;
  const [otherMembership] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${other.id} and role = 'owner' limit 1`;
  const duration = options.durationMinutes ?? 30;
  await owner.begin(async (transaction) => {
    await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${practitionerId}, ${tenant.id}, ${options.name}, 'Dentist', 'FT', 'Testing')`;
    await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenant.id}, ${practitionerId}, ${location.id})`;
    await transaction`
      insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
        slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, price_minor)
      values (${serviceId}, ${tenant.id}, ${`${options.name} Service`}, 'Local integration test', ${duration}, 0, 0, ${duration}, 0, 60, 'instant', ${["new", "returning"]}, 1000)`;
    await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenant.id}, ${serviceId}, ${location.id})`;
    await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenant.id}, ${practitionerId}, ${serviceId})`;
    for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
      await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${tenant.id}, ${location.id}, ${practitionerId}, ${dayOfWeek}, '00:00', '23:59', ${location.timezone}, '2025-01-01', ${duration})`;
    }
    for (const [column, value] of Object.entries(options.service ?? {})) {
      if (!/^[a-z_]+$/.test(column)) throw new Error("Bad column name");
      await transaction.unsafe(`update services set ${column} = $1 where id = $2`, [value, serviceId]);
    }
  });
  const staff = (tenantId: string, tenantSlug: string, name: string, userId: string | undefined): StaffContext => ({
    tenantId, clinicSlug: tenantSlug, clinicName: name, role: "owner", permissions: resolvePermissions("owner", {}),
    membershipId: null, userId: userId ?? null, userName: "Fixture", userEmail: "fixture@example.com", preview: false,
  });
  return {
    owner, tenantId: tenant.id, otherTenantId: other.id, locationId: location.id, practitionerId, serviceId, slug,
    context: staff(tenant.id, slug, tenant.name, membership?.user_id),
    outsider: staff(other.id, other.slug, other.name, otherMembership?.user_id),
    bookingInput(startsAt, endsAt, email, extra) {
      return {
        clinicSlug: slug, patientType: "new", bookingFor: "self", locationId: location.id, serviceId, practitionerId,
        slotId: `${practitionerId}:${startsAt}`, startsAt, endsAt, firstName: "Fixture", lastName: "Customer",
        phone: `+9190${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, email, preferredChannel: "email",
        acceptedPrivacyNotice: true, messagingConsent: false, ...extra,
      };
    },
    async cleanup() {
      try {
        const mine = owner`select id from appointments where tenant_id = ${tenant.id} and service_id = ${serviceId}`;
        await owner`delete from refund_requests where payment_id in (select id from payments where appointment_id in (${mine}))`;
        // Money rows refuse DELETE (migration 0075); test cleanup switches the guard off for its own transaction only.
        await owner.begin(async (transaction) => {
          await transaction`alter table payments disable trigger payments_final`;
          await transaction`alter table payment_refunds disable trigger payment_refunds_final`;
          await transaction`delete from payment_refunds where payment_id in (select id from payments where appointment_id in (select id from appointments where tenant_id = ${tenant.id} and service_id = ${serviceId}))`;
          await transaction`delete from payments where appointment_id in (select id from appointments where tenant_id = ${tenant.id} and service_id = ${serviceId})`;
          await transaction`alter table payments enable trigger payments_final`;
          await transaction`alter table payment_refunds enable trigger payment_refunds_final`;
        });
        await owner`delete from audit_events where appointment_id in (${mine})`;
        await owner`delete from outbox_events where tenant_id = ${tenant.id} and aggregate_type = 'appointment' and aggregate_id in (${mine})`;
        await owner`delete from scheduled_messages where appointment_id in (${mine})`;
        await owner`delete from appointments where tenant_id = ${tenant.id} and service_id = ${serviceId}`;
        await owner`delete from services where id = ${serviceId}`;
        await owner`delete from practitioners where id = ${practitionerId}`;
      } finally {
        await owner.end();
      }
    },
  };
}

/** An ISO start `days` from now at `hour:00` in Asia/Kolkata (the seeded business's zone). */
export function startIn(days: number, hour: number, minute = 0): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));
  return new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000+05:30`).toISOString();
}

export function plusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}
