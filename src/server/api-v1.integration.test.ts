/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";
import { isolatedDatabaseReady } from "@/test/isolated-database";

import { GET as listAppointmentsRoute, POST as createAppointmentRoute } from "@/app/api/v1/appointments/route";
import { GET as getAppointmentRoute } from "@/app/api/v1/appointments/[id]/route";
import { POST as cancelRoute } from "@/app/api/v1/appointments/[id]/cancel/route";
import { POST as rescheduleRoute } from "@/app/api/v1/appointments/[id]/reschedule/route";
import { GET as availabilityRoute } from "@/app/api/v1/availability/route";
import { GET as listCustomersRoute, POST as createCustomerRoute } from "@/app/api/v1/customers/route";
import { GET as getCustomerRoute } from "@/app/api/v1/customers/[id]/route";
import { GET as servicesRoute } from "@/app/api/v1/services/route";
import { GET as staffRoute } from "@/app/api/v1/staff/route";
import { GET as extensionTodayRoute } from "@/app/api/ext/today/route";
import { apiScopes, type ApiScope } from "@/lib/api-scopes";
import { generateApiKey } from "@/server/api-key-context";
import { appointmentSchema, customerSchema, errorSchema, listOf, oneOf, serviceSchema, slotSchema, staffSchema } from "@/server/api-v1-contracts";
import { ApiError } from "@/server/api-error";
import { createStaffAppointment } from "@/server/appointment-repository";
import { staffBookingSchema } from "@/server/contracts";
import { canonicalJsonHash } from "@/server/crypto";
import { getStaffSnapshot } from "@/server/staff-repository";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeDb = isolatedDatabaseReady(process.env.DATABASE_URL, ownerUrl) ? describe : describe.skip;

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface Call {
  key?: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  idempotencyKey?: string | null;
}

describeDb("public API v1", () => {
  let owner: postgres.Sql;
  let tenantA = "";
  let tenantB = "";
  let locationId = "";
  const practitionerId = randomUUID();
  const serviceId = randomUUID();
  const createdKeys: string[] = [];
  const idempotencyKeys: string[] = [];
  let fullKey = "";
  let keyId = "";
  let businessBKey = "";
  let ownerUserId = "";
  let slots: Array<{ startsAt: string; endsAt: string; staffId: string }> = [];
  let cursor = 0;

  async function makeKey(tenantId: string, options: { scopes?: readonly ApiScope[]; mode?: "live" | "test"; revoked?: boolean; expired?: boolean } = {}): Promise<{ key: string; id: string }> {
    const generated = generateApiKey(options.mode ?? "live");
    const id = randomUUID();
    await owner`
      insert into api_keys (id, tenant_id, name, prefix, key_hash, scopes, mode, expires_at, revoked_at)
      values (${id}, ${tenantId}, 'v1 test', ${generated.prefix}, ${generated.keyHash}, ${[...(options.scopes ?? apiScopes)]}, ${options.mode ?? "live"},
        ${options.expired ? new Date(Date.now() - 60_000) : null}, ${options.revoked ? new Date() : null})`;
    createdKeys.push(id);
    return { key: generated.key, id };
  }

  async function call(handler: Handler, path: string, options: Call & { method?: "GET" | "POST" } = {}): Promise<{ status: number; headers: Headers; json: unknown }> {
    const url = new URL(`http://localhost${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const headers = new Headers(options.headers);
    headers.set("authorization", `Bearer ${options.key ?? fullKey}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.idempotencyKey !== null && (options.method ?? "GET") === "POST") {
      const value = options.idempotencyKey ?? `test-${randomUUID()}`;
      idempotencyKeys.push(value);
      headers.set("idempotency-key", value);
    }
    const response = await handler(new Request(url, {
      method: options.method ?? "GET", headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }), { params: Promise.resolve(options.params ?? {}) });
    return { status: response.status, headers: response.headers, json: await response.json() as unknown };
  }

  const nextSlot = () => {
    const slot = slots[cursor];
    cursor += 3;
    if (!slot) throw new Error("Ran out of test slots");
    return slot;
  };
  const customerBody = (label: string) => ({ firstName: "Zorblax", lastName: label, phone: "+91 90000 00456", email: `${label.toLowerCase()}@example.com` });
  const keysOf = (value: unknown): string[] => Array.isArray(value)
    ? value.flatMap(keysOf)
    : typeof value === "object" && value !== null ? Object.entries(value).flatMap(([name, child]) => [name, ...keysOf(child)]) : [];
  const errorCode = (json: unknown) => errorSchema.parse(json).error.code;

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    const [a] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [b] = await owner<{ id: string }[]>`select id from tenants where slug = 'riverbend-care'`;
    tenantA = a!.id;
    tenantB = b!.id;
    ownerUserId = (await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenantA} and role = 'owner' and is_active limit 1`)[0]!.user_id;
    locationId = (await owner<{ id: string }[]>`select id from locations where tenant_id = ${tenantA} and is_active order by created_at, id limit 1`)[0]!.id;
    await owner.begin(async (transaction) => {
      await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${practitionerId}, ${tenantA}, 'Api Test', 'Dentist', 'AT', 'Testing')`;
      await transaction`
        insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
          slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types)
        values (${serviceId}, ${tenantA}, 'Api Test Service', 'Local integration test', 15, 0, 0, 15, 120, 90, 'instant', ${["new", "returning"]})`;
      await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantA}, ${serviceId}, ${locationId})`;
      await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantA}, ${practitionerId}, ${serviceId})`;
      await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantA}, ${practitionerId}, ${locationId})`;
      for (let day = 1; day <= 7; day += 1) {
        await transaction`
          insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
          values (${randomUUID()}, ${tenantA}, ${locationId}, ${practitionerId}, ${day}, '00:00', '23:45', 'Asia/Kolkata', '2025-01-01', 15)`;
      }
    });
    ({ key: fullKey, id: keyId } = await makeKey(tenantA));
    businessBKey = (await makeKey(tenantB)).key;
  });

  afterAll(async () => {
    const appointmentIds = (await owner<{ id: string }[]>`select id from appointments where service_id = ${serviceId}`).map((row) => row.id);
    const patientIds = (await owner<{ patient_id: string }[]>`select distinct patient_id from appointments where service_id = ${serviceId}`).map((row) => row.patient_id);
    const customerIds = (await owner<{ id: string }[]>`select id from patients where tenant_id = ${tenantA} and email like '%@api-v1.test'`).map((row) => row.id);
    await owner.begin(async (transaction) => {
      if (appointmentIds.length) {
        await transaction`delete from audit_events where appointment_id in ${transaction(appointmentIds)}`;
        await transaction`delete from outbox_events where tenant_id = ${tenantA} and aggregate_id in ${transaction(appointmentIds)}`;
        await transaction`delete from resource_reservations where appointment_id in ${transaction(appointmentIds)}`;
        await transaction`delete from appointments where id in ${transaction(appointmentIds)}`;
      }
      const everyone = [...new Set([...patientIds, ...customerIds])];
      if (everyone.length) {
        await transaction`delete from audit_events where tenant_id = ${tenantA} and metadata->>'patientId' in ${transaction(everyone)}`;
        await transaction`delete from outbox_events where tenant_id = ${tenantA} and aggregate_id in ${transaction(everyone)}`;
        await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in ${transaction(everyone)})`;
        await transaction`delete from patients where id in ${transaction(everyone)}`;
      }
      if (idempotencyKeys.length) await transaction`delete from idempotency_keys where key in ${transaction(idempotencyKeys)}`;
      await transaction`delete from availability_rules where practitioner_id = ${practitionerId}`;
      await transaction`delete from practitioner_services where practitioner_id = ${practitionerId}`;
      await transaction`delete from practitioner_locations where practitioner_id = ${practitionerId}`;
      await transaction`delete from service_locations where service_id = ${serviceId}`;
      await transaction`delete from services where id = ${serviceId}`;
      await transaction`delete from practitioners where id = ${practitionerId}`;
      if (createdKeys.length) await transaction`delete from api_keys where id in ${transaction(createdKeys)}`;
    });
    await owner.end();
  });

  it("lists services and staff in the v1 shapes, and never leaks internal names", async () => {
    const services = await call(servicesRoute, "/api/v1/services", { query: { limit: "100" } });
    expect(services.status).toBe(200);
    const parsedServices = listOf(serviceSchema).parse(services.json);
    expect(parsedServices.data.some((service) => service.id === serviceId && service.bookingMode === "instant")).toBe(true);
    const staff = await call(staffRoute, "/api/v1/staff", { query: { limit: "100" } });
    expect(listOf(staffSchema).parse(staff.json).data.some((member) => member.id === practitionerId)).toBe(true);
    expect(keysOf([services.json, staff.json]).join(" ")).not.toMatch(/practitioner|clinicSlug|patient/i);
    expect(services.headers.get("x-ratelimit-limit")).toBe("600");
    expect(Number(services.headers.get("x-ratelimit-remaining"))).toBeLessThan(600);
    expect(Number(services.headers.get("x-ratelimit-reset"))).toBeGreaterThan(Date.now() / 1000);
  });

  it("lists availability, books a slot, and shows it to staff with the key in the audit trail", async () => {
    const from = new Date(Date.now() + 86_400_000);
    const availability = await call(availabilityRoute, "/api/v1/availability", {
      query: { serviceId, from: from.toISOString(), to: new Date(from.getTime() + 2 * 86_400_000).toISOString() },
    });
    expect(availability.status).toBe(200);
    slots = listOf(slotSchema).parse(availability.json).data;
    expect(slots.length).toBeGreaterThan(60);
    expect(slots[0]?.staffId).toBe(practitionerId);

    const slot = nextSlot();
    const key = `book-${randomUUID()}`;
    const booked = await call(createAppointmentRoute, "/api/v1/appointments", {
      method: "POST", idempotencyKey: key,
      body: { serviceId, staffId: slot.staffId, startsAt: slot.startsAt, customer: { ...customerBody("Booked"), email: "booked@api-v1.test" }, reasonForVisit: "Check-up" },
    });
    expect(booked.status).toBe(201);
    const appointment = oneOf(appointmentSchema).parse(booked.json).data;
    expect(appointment).toMatchObject({ status: "booked", serviceId, staffId: practitionerId, startsAt: slot.startsAt, locationId, reasonForVisit: "Check-up" });
    expect(JSON.stringify(booked.json)).not.toMatch(/manage/i);

    // The same Idempotency-Key and body returns the same booking, not a second one.
    const replay = await call(createAppointmentRoute, "/api/v1/appointments", {
      method: "POST", idempotencyKey: key,
      body: { serviceId, staffId: slot.staffId, startsAt: slot.startsAt, customer: { ...customerBody("Booked"), email: "booked@api-v1.test" }, reasonForVisit: "Check-up" },
    });
    expect(oneOf(appointmentSchema).parse(replay.json).data.id).toBe(appointment.id);
    expect((await owner`select count(*)::int as count from appointments where service_id = ${serviceId} and starts_at = ${slot.startsAt}`)[0]?.count).toBe(1);
    // The same key with a different body is refused.
    const clash = await call(createAppointmentRoute, "/api/v1/appointments", {
      method: "POST", idempotencyKey: key, body: { serviceId, staffId: slot.staffId, startsAt: slot.startsAt, customerId: appointment.customerId },
    });
    expect([clash.status, errorCode(clash.json)]).toEqual([409, "idempotency_conflict"]);

    // Staff see it in the schedule data, and it is on the audit trail under the key.
    const staffContext: StaffContext = {
      tenantId: tenantA, clinicSlug: "lotus-dental", clinicName: "Lotus Dental Studio", role: "owner", permissions: resolvePermissions("owner", {}),
      membershipId: null, userId: null, userName: "Desk", userEmail: "test@example.com", preview: false,
    };
    const snapshot = await getStaffSnapshot(staffContext);
    expect(snapshot.appointments.some((row) => row.id === appointment.id)).toBe(true);
    const [audit] = await owner<{ actor_type: string; metadata: { apiKeyId?: string } }[]>`
      select actor_type, metadata from audit_events where appointment_id = ${appointment.id} and action = 'appointment.created'`;
    expect(audit?.actor_type).toBe("api_key");
    expect(audit?.metadata.apiKeyId).toBe(keyId);
    // A customer added with the booking is announced to webhooks too, once.
    expect((await owner`select count(*)::int as count from outbox_events where tenant_id = ${tenantA} and event_type = 'customer.created' and aggregate_id = ${appointment.customerId}`)[0]?.count).toBe(1);
  });

  it("moves and cancels an appointment, guarding with the version when it is sent", async () => {
    const first = nextSlot();
    const second = nextSlot();
    const booked = await call(createAppointmentRoute, "/api/v1/appointments", {
      method: "POST", body: { serviceId, staffId: first.staffId, startsAt: first.startsAt, customer: { ...customerBody("Mover"), email: "mover@api-v1.test" } },
    });
    const appointment = oneOf(appointmentSchema).parse(booked.json).data;
    const params = { id: appointment.id };

    const stale = await call(rescheduleRoute, `/api/v1/appointments/${appointment.id}/reschedule`, { method: "POST", params, body: { startsAt: second.startsAt, version: 99 } });
    expect([stale.status, errorCode(stale.json)]).toEqual([409, "version_conflict"]);

    const moved = await call(rescheduleRoute, `/api/v1/appointments/${appointment.id}/reschedule`, { method: "POST", idempotencyKey: null, params, body: { startsAt: second.startsAt } });
    expect(moved.status).toBe(200);
    expect(oneOf(appointmentSchema).parse(moved.json).data).toMatchObject({ startsAt: second.startsAt, version: appointment.version + 1 });

    const cancelled = await call(cancelRoute, `/api/v1/appointments/${appointment.id}/cancel`, { method: "POST", idempotencyKey: null, params, body: { reason: "Asked to cancel", version: appointment.version + 1 } });
    expect(oneOf(appointmentSchema).parse(cancelled.json).data).toMatchObject({ status: "cancelled" });
    expect(oneOf(appointmentSchema).parse(cancelled.json).data.cancelledAt).not.toBeNull();
    const [audit] = await owner<{ actor_type: string; metadata: { apiKeyId?: string } }[]>`
      select actor_type, metadata from audit_events where appointment_id = ${appointment.id} and action like '%cancel%' order by occurred_at desc limit 1`;
    expect(audit?.actor_type).toBe("api_key");
    expect(audit?.metadata.apiKeyId).toBe(keyId);

    const again = await call(cancelRoute, `/api/v1/appointments/${appointment.id}/cancel`, { method: "POST", idempotencyKey: null, params });
    // The app treats cancelling a cancelled visit as settled, so the API answers the same way and nothing changes.
    expect(oneOf(appointmentSchema).parse(again.json).data.status).toBe("cancelled");
    // A cancelled time is offered again.
    const reused = await call(createAppointmentRoute, "/api/v1/appointments", {
      method: "POST", body: { serviceId, staffId: second.staffId, startsAt: second.startsAt, customerId: appointment.customerId },
    });
    expect(reused.status).toBe(201);
  });

  it("refuses a time that is not offered, exactly as the app does", async () => {
    const soon = new Date(Date.now() + 30 * 60_000);
    soon.setUTCMinutes(Math.ceil(soon.getUTCMinutes() / 15) * 15, 0, 0);
    const refused = await call(createAppointmentRoute, "/api/v1/appointments", {
      method: "POST", body: { serviceId, staffId: practitionerId, startsAt: soon.toISOString(), customer: { ...customerBody("Early"), email: "early@api-v1.test" } },
    });
    // Thirty minutes ahead is inside the minimum notice, a soft rule, so both answer `outside_booking_rules`.
    expect([refused.status, errorCode(refused.json)]).toEqual([409, "outside_booking_rules"]);

    const input = staffBookingSchema.parse({
      clinicSlug: "lotus-dental", locationId, serviceId, practitionerId, startsAt: soon.toISOString(), source: "desk",
      newPatient: { firstName: "Zorblax", lastName: "Early", phone: "+91 90000 00456", email: "early@api-v1.test", preferredChannel: "email" },
    });
    const staffContext: StaffContext = {
      tenantId: tenantA, clinicSlug: "lotus-dental", clinicName: "Lotus Dental Studio", role: "owner", permissions: resolvePermissions("owner", {}),
      membershipId: null, userId: ownerUserId, userName: "Desk", userEmail: "test@example.com", preview: false,
    };
    const inApp = await createStaffAppointment(staffContext, input, `app-${randomUUID()}`, canonicalJsonHash(input)).catch((error: unknown) => error);
    expect(inApp).toBeInstanceOf(ApiError);
    expect(inApp).toMatchObject({ status: 409, code: errorCode(refused.json) });
  });

  it("checks scopes, key mode, revocation and expiry", async () => {
    const readOnly = await makeKey(tenantA, { scopes: ["appointments:read"] });
    const noWrite = await call(createAppointmentRoute, "/api/v1/appointments", { method: "POST", key: readOnly.key, body: {} });
    expect([noWrite.status, errorCode(noWrite.json)]).toEqual([403, "insufficient_scope"]);
    const wrongScope = await call(servicesRoute, "/api/v1/services", { key: readOnly.key });
    expect([wrongScope.status, errorCode(wrongScope.json)]).toEqual([403, "insufficient_scope"]);

    const testKey = await makeKey(tenantA, { mode: "test" });
    const testWrite = await call(createCustomerRoute, "/api/v1/customers", { method: "POST", key: testKey.key, body: customerBody("Tester") });
    expect([testWrite.status, errorCode(testWrite.json)]).toEqual([403, "test_key_read_only"]);
    expect((await call(servicesRoute, "/api/v1/services", { key: testKey.key })).status).toBe(200);

    for (const options of [{ revoked: true }, { expired: true }] as const) {
      const dead = await makeKey(tenantA, options);
      const response = await call(servicesRoute, "/api/v1/services", { key: dead.key });
      expect([response.status, errorCode(response.json)]).toEqual([401, "invalid_api_key"]);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    }
    const none = await servicesRoute(new Request("http://localhost/api/v1/services"), { params: Promise.resolve({}) });
    expect(none.status).toBe(401);
  });

  it("stops a key working when the business moves to a plan without the API, but not the browser extension", async () => {
    const [before] = await owner<{ plan_key: string; status: string }[]>`select plan_key, status from tenant_subscriptions where tenant_id = ${tenantA}`;
    await owner`update tenant_subscriptions set plan_key = 'free', status = 'free' where tenant_id = ${tenantA}`;
    try {
      const refused = await call(servicesRoute, "/api/v1/services", { key: fullKey });
      expect([refused.status, errorCode(refused.json)]).toEqual([402, "plan_limit"]);
      // The browser extension is not the API and keeps working on every plan.
      expect((await call(extensionTodayRoute, "/api/ext/today", { key: fullKey })).status).toBe(200);
    } finally {
      await owner`update tenant_subscriptions set plan_key = ${before!.plan_key}, status = ${before!.status} where tenant_id = ${tenantA}`;
    }
    expect((await call(servicesRoute, "/api/v1/services", { key: fullKey })).status).toBe(200);
  });

  it("adds customers once per Idempotency-Key, finds them by phone and email, and queues the webhook event", async () => {
    const key = `cust-${randomUUID()}`;
    const body = { ...customerBody("Finder"), email: "Finder@api-v1.test", phone: "+91 90000 00789" };
    const created = await call(createCustomerRoute, "/api/v1/customers", { method: "POST", idempotencyKey: key, body });
    expect(created.status).toBe(201);
    const customer = oneOf(customerSchema).parse(created.json).data;
    const replay = await call(createCustomerRoute, "/api/v1/customers", { method: "POST", idempotencyKey: key, body });
    expect(oneOf(customerSchema).parse(replay.json).data.id).toBe(customer.id);
    expect((await owner`select count(*)::int as count from outbox_events where event_type = 'customer.created' and aggregate_id = ${customer.id}`)[0]?.count).toBe(1);
    const [audit] = await owner<{ actor_type: string }[]>`select actor_type from audit_events where tenant_id = ${tenantA} and metadata->>'patientId' = ${customer.id}`;
    expect(audit?.actor_type).toBe("api_key");
    const missingKey = await call(createCustomerRoute, "/api/v1/customers", { method: "POST", idempotencyKey: null, body });
    expect([missingKey.status, errorCode(missingKey.json)]).toEqual([400, "invalid_idempotency_key"]);

    const queries: Array<Record<string, string>> = [{ phone: "9000000789" }, { phone: "+91-90000-00789" }, { email: "FINDER@api-v1.test" }];
    for (const query of queries) {
      const found = listOf(customerSchema).parse((await call(listCustomersRoute, "/api/v1/customers", { query })).json).data;
      expect(found.map((row) => row.id)).toContain(customer.id);
    }
    const none = listOf(customerSchema).parse((await call(listCustomersRoute, "/api/v1/customers", { query: { email: "nobody@api-v1.test" } })).json);
    expect(none.data).toEqual([]);
    expect((await call(getCustomerRoute, `/api/v1/customers/${customer.id}`, { params: { id: customer.id } })).status).toBe(200);
    const bad = await call(createCustomerRoute, "/api/v1/customers", { method: "POST", body: { firstName: "x" } });
    expect([bad.status, errorCode(bad.json)]).toEqual([400, "validation_error"]);
  });

  it("keeps one business out of another: reads, moves, cancels and bookings with its customers are all 404", async () => {
    const slot = nextSlot();
    const booked = oneOf(appointmentSchema).parse((await call(createAppointmentRoute, "/api/v1/appointments", {
      method: "POST", body: { serviceId, staffId: slot.staffId, startsAt: slot.startsAt, customer: { ...customerBody("Private"), email: "private@api-v1.test" } },
    })).json).data;
    const params = { id: booked.id };
    const asB = { key: businessBKey, params };

    const read = await call(getAppointmentRoute, `/api/v1/appointments/${booked.id}`, asB);
    expect([read.status, errorCode(read.json)]).toEqual([404, "appointment_not_found"]);
    const move = await call(rescheduleRoute, `/api/v1/appointments/${booked.id}/reschedule`, { ...asB, method: "POST", body: { startsAt: nextSlot().startsAt } });
    expect(move.status).toBe(404);
    const cancel = await call(cancelRoute, `/api/v1/appointments/${booked.id}/cancel`, { ...asB, method: "POST" });
    expect(cancel.status).toBe(404);
    const customer = await call(getCustomerRoute, `/api/v1/customers/${booked.customerId}`, { key: businessBKey, params: { id: booked.customerId } });
    expect([customer.status, errorCode(customer.json)]).toEqual([404, "customer_not_found"]);
    const book = await call(createAppointmentRoute, "/api/v1/appointments", {
      key: businessBKey, method: "POST", body: { serviceId, staffId: practitionerId, startsAt: nextSlot().startsAt, customerId: booked.customerId },
    });
    expect([book.status, errorCode(book.json)]).toEqual([404, "customer_not_found"]);
    const list = listOf(appointmentSchema).parse((await call(listAppointmentsRoute, "/api/v1/appointments", { key: businessBKey })).json);
    expect(list.data.map((row) => row.id)).not.toContain(booked.id);
    const customers = listOf(customerSchema).parse((await call(listCustomersRoute, "/api/v1/customers", { key: businessBKey, query: { limit: "100" } })).json);
    expect(customers.data.map((row) => row.id)).not.toContain(booked.customerId);
    const unknown = await call(getAppointmentRoute, "/api/v1/appointments/does-not-exist", { params: { id: "does-not-exist" } });
    expect([unknown.status, errorCode(unknown.json)]).toEqual([404, "appointment_not_found"]);
    const odd = await call(getAppointmentRoute, "/api/v1/appointments/x", { params: { id: "../etc" } });
    expect(odd.status).toBe(404);
  });

  it("pages every row exactly once, newest first, and refuses a made-up cursor", async () => {
    for (let index = 0; index < 4; index += 1) {
      const slot = nextSlot();
      await call(createAppointmentRoute, "/api/v1/appointments", {
        method: "POST", body: { serviceId, staffId: slot.staffId, startsAt: slot.startsAt, customer: { ...customerBody(`Pager${index}`), email: `pager${index}@api-v1.test` } },
      });
    }
    const seen: string[] = [];
    const starts: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const page: { status: number; json: unknown } = await call(listAppointmentsRoute, "/api/v1/appointments", { query: { limit: "3", ...(next ? { cursor: next } : {}) } });
      const parsed = listOf(appointmentSchema).parse(page.json);
      expect(parsed.hasMore).toBe(parsed.nextCursor !== null);
      seen.push(...parsed.data.map((row) => row.id));
      starts.push(...parsed.data.map((row) => row.startsAt));
      next = parsed.nextCursor;
      pages += 1;
    } while (next && pages < 100);
    const everything = (await owner<{ id: string }[]>`select id from appointments where tenant_id = ${tenantA}`).map((row) => row.id);
    expect(seen.length).toBe(new Set(seen).size);
    expect([...seen].sort()).toEqual([...everything].sort());
    expect(starts).toEqual([...starts].sort().reverse());
    expect(pages).toBeGreaterThan(1);

    const customerSeen: string[] = [];
    let customerNext: string | null = null;
    do {
      const page: { json: unknown } = await call(listCustomersRoute, "/api/v1/customers", { query: { limit: "4", ...(customerNext ? { cursor: customerNext } : {}) } });
      const parsed = listOf(customerSchema).parse(page.json);
      customerSeen.push(...parsed.data.map((row) => row.id));
      customerNext = parsed.nextCursor;
    } while (customerNext);
    const allCustomers = (await owner<{ id: string }[]>`select id from patients where tenant_id = ${tenantA} and erased_at is null`).map((row) => row.id);
    expect(customerSeen.length).toBe(new Set(customerSeen).size);
    expect([...customerSeen].sort()).toEqual([...allCustomers].sort());

    const garbage = await call(listAppointmentsRoute, "/api/v1/appointments", { query: { cursor: "not-a-cursor" } });
    expect([garbage.status, errorCode(garbage.json)]).toEqual([400, "invalid_cursor"]);
  });

  it("answers the 601st request in a minute with 429 and Retry-After", async () => {
    const busy = await makeKey(tenantA, { scopes: ["services:read"] });
    // The limit counts in whole minutes, so start with enough of the minute left to finish the loop inside it.
    if (new Date().getSeconds() > 40) await new Promise((resolve) => setTimeout(resolve, (62 - new Date().getSeconds()) * 1_000));
    let last: Awaited<ReturnType<typeof call>> | null = null;
    for (let count = 1; count <= 601; count += 1) {
      last = await call(servicesRoute, "/api/v1/services", { key: busy.key, query: { limit: "1" } });
      if (count === 600) expect(last.status).toBe(200);
    }
    expect(last?.status).toBe(429);
    expect(errorCode(last?.json)).toBe("rate_limited");
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(last?.headers.get("x-ratelimit-remaining")).toBe("0");
  }, 120_000);
});
