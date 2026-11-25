/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));

import { POST as mcpRoute } from "@/app/api/mcp/route";
import { GET as catalogRoute } from "@/app/api/public/catalog/route";
import { apiScopes, type ApiScope } from "@/lib/api-scopes";
import { generateApiKey, type ApiKeyContext } from "@/server/api-key-context";
import { bookAppointment } from "@/server/api-v1-writes";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeDb = isolatedDatabaseReady(process.env.DATABASE_URL, ownerUrl) ? describe : describe.skip;

interface Reply { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: { result?: unknown } }

describeDb("MCP server", () => {
  let owner: postgres.Sql;
  let tenantA = "";
  let tenantB = "";
  let locationId = "";
  const practitionerId = randomUUID();
  const serviceId = randomUUID();
  const createdKeys: string[] = [];
  const clients: Client[] = [];
  let writeKey = "";
  let readKey = "";
  let otherKey = "";
  let keyContext: ApiKeyContext;
  // A fresh network range per run, so counts from an earlier run in the same minute never carry over.
  const ipBase = `198.51.${Math.floor(Math.random() * 200) + 1}`;
  let ipCounter = 0;

  async function makeKey(tenantId: string, scopes: readonly ApiScope[]): Promise<{ key: string; id: string }> {
    const generated = generateApiKey("live");
    const id = randomUUID();
    await owner`insert into api_keys (id, tenant_id, name, prefix, key_hash, scopes, mode) values (${id}, ${tenantId}, 'mcp test', ${generated.prefix}, ${generated.keyHash}, ${[...scopes]}, 'live')`;
    createdKeys.push(id);
    return { key: generated.key, id };
  }

  /** An MCP client whose HTTP calls go straight into the route handler, with its own network address. */
  async function connect(key?: string): Promise<Client> {
    ipCounter += 1;
    const address = `${ipBase}.${ipCounter}`;
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
      requestInit: { headers: { "x-forwarded-for": address, ...(key ? { authorization: `Bearer ${key}` } : {}) } },
      fetch: (input, init) => mcpRoute(new Request(input as string | URL, init)),
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers are checked field by field below
  async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ error: boolean; data: Record<string, any> }> {
    const reply = await client.callTool({ name, arguments: args }) as Reply;
    const text = reply.content[0]?.text ?? "null";
    return { error: reply.isError === true, data: JSON.parse(text) };
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    tenantA = (await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`)[0]!.id;
    tenantB = (await owner<{ id: string }[]>`select id from tenants where slug = 'riverbend-care'`)[0]!.id;
    locationId = (await owner<{ id: string }[]>`select id from locations where tenant_id = ${tenantA} and is_active order by created_at, id limit 1`)[0]!.id;
    await owner.begin(async (transaction) => {
      await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${practitionerId}, ${tenantA}, 'Mcp Tester', 'Dentist', 'MT', 'Testing')`;
      await transaction`
        insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
          slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, slug)
        values (${serviceId}, ${tenantA}, 'Mcp Test Service', 'Local integration test', 15, 0, 0, 15, 120, 90, 'instant', ${["new", "returning"]}, 'mcp-test-service')`;
      await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantA}, ${serviceId}, ${locationId})`;
      await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantA}, ${practitionerId}, ${serviceId})`;
      await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantA}, ${practitionerId}, ${locationId})`;
      for (let day = 1; day <= 7; day += 1) {
        await transaction`
          insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
          values (${randomUUID()}, ${tenantA}, ${locationId}, ${practitionerId}, ${day}, '00:00', '23:45', 'Asia/Kolkata', '2025-01-01', 15)`;
      }
    });
    const write = await makeKey(tenantA, apiScopes);
    writeKey = write.key;
    readKey = (await makeKey(tenantA, ["appointments:read", "services:read"])).key;
    otherKey = (await makeKey(tenantB, apiScopes)).key;
    keyContext = {
      tenantId: tenantA, clinicSlug: "lotus-dental", clinicName: "Lotus", keyId: write.id, keyPrefix: "kal_live_test", scopes: apiScopes, mode: "live",
      rate: { rule: "api_key.minute", allowed: true, count: 1, limit: 600, resetAt: new Date(Date.now() + 60_000), retryAfterSeconds: 60 },
    };
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    const appointmentIds = (await owner<{ id: string }[]>`select id from appointments where service_id = ${serviceId}`).map((row) => row.id);
    const patientIds = (await owner<{ patient_id: string }[]>`select distinct patient_id from appointments where service_id = ${serviceId}`).map((row) => row.patient_id);
    await owner.begin(async (transaction) => {
      await transaction`delete from slot_holds where service_id = ${serviceId}`;
      if (appointmentIds.length) {
        await transaction`delete from audit_events where appointment_id in ${transaction(appointmentIds)}`;
        await transaction`delete from outbox_events where tenant_id = ${tenantA} and aggregate_id in ${transaction(appointmentIds)}`;
        await transaction`delete from resource_reservations where appointment_id in ${transaction(appointmentIds)}`;
        await transaction`delete from appointments where id in ${transaction(appointmentIds)}`;
      }
      if (patientIds.length) {
        await transaction`delete from audit_events where tenant_id = ${tenantA} and metadata->>'patientId' in ${transaction(patientIds)}`;
        await transaction`delete from outbox_events where tenant_id = ${tenantA} and aggregate_id in ${transaction(patientIds)}`;
        await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in ${transaction(patientIds)})`;
        await transaction`delete from patients where id in ${transaction(patientIds)}`;
      }
      await transaction`delete from idempotency_keys where key like 'mcp-test-%'`;
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

  const dayAhead = () => new Date(Date.now() + 86_400_000);
  const window = () => ({ from: dayAhead().toISOString(), to: new Date(dayAhead().getTime() + 86_400_000).toISOString() });

  it("lists its tools with the official client", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["add_booking_note", "cancel_booking", "find_open_times", "list_people", "list_services", "list_todays_bookings", "reschedule_booking", "start_booking"]);
  });

  it("answers public questions without a key and shows no customer data", async () => {
    const client = await connect();
    const services = await callTool(client, "list_services", { business: "lotus-dental" });
    expect(services.error).toBe(false);
    expect(services.data.services.some((service: { id: string }) => service.id === serviceId)).toBe(true);
    const people = await callTool(client, "list_people", { business: "lotus-dental", serviceId });
    expect(people.data.people).toEqual([expect.objectContaining({ id: practitionerId, name: "Mcp Tester" })]);
    expect(JSON.stringify([services.data, people.data])).not.toMatch(/phone|email|registration|patient/i);
    const missing = await callTool(client, "list_services", { business: "no-such-business" });
    expect(missing.error).toBe(true);
    expect(missing.data.code).toBe("clinic_not_found");
  });

  it("serves the website components' catalog with no customer data, and refuses a bad business name", async () => {
    const headers = { "x-forwarded-for": `${ipBase}.250` };
    const ok = await catalogRoute(new Request("http://localhost/api/public/catalog?clinicSlug=lotus-dental", { headers }));
    expect(ok.status).toBe(200);
    const { data } = await ok.json() as { data: { services: Array<{ id: string; locationIds: string[] }>; locations: unknown[]; people: unknown[] } };
    expect(data.services.find((service) => service.id === serviceId)?.locationIds).toEqual([locationId]);
    expect(JSON.stringify(data)).not.toMatch(/phone|email|registration|patient/i);
    const bad = await catalogRoute(new Request("http://localhost/api/public/catalog?clinicSlug=Not%20A%20Slug", { headers }));
    expect(bad.status).toBe(400);
  });

  it("finds open times and starts a booking that is only a held link, never a booking", async () => {
    const client = await connect();
    const found = await callTool(client, "find_open_times", { business: "lotus-dental", serviceId, ...window() });
    expect(found.error).toBe(false);
    expect(found.data.times.length).toBeGreaterThan(3);
    const time = found.data.times[0];
    const started = await callTool(client, "start_booking", { business: "lotus-dental", serviceId, personId: time.personId, startsAt: time.startsAt });
    expect(started.error).toBe(false);
    expect(started.data.status).toBe("awaiting_customer_confirmation");
    const link = new URL(started.data.bookingLink);
    expect(link.pathname).toBe("/book/lotus-dental/mcp-test-service");
    expect(link.searchParams.get("time")).toBe(time.startsAt);
    expect(link.searchParams.get("person")).toBe(practitionerId);
    const heldFor = new Date(started.data.heldUntil).getTime() - Date.now();
    expect(heldFor).toBeGreaterThan(4 * 60_000);
    expect(heldFor).toBeLessThanOrEqual(5 * 60_000);
    const booked = await owner`select count(*)::int as n from appointments where service_id = ${serviceId}`;
    expect(booked[0]!.n).toBe(0);
    // The held time is closed to everyone else, and an invented time is refused.
    const again = await callTool(client, "start_booking", { business: "lotus-dental", serviceId, personId: time.personId, startsAt: time.startsAt });
    expect(again.error).toBe(true);
    expect(again.data.code).toBe("slot_unavailable");
    const invented = await callTool(client, "start_booking", { business: "lotus-dental", serviceId, personId: practitionerId, startsAt: "2031-01-01T03:07:00.000Z" });
    expect(invented.data.code).toBe("slot_unavailable");
    // The customer who opens the link swaps the assistant's hold for their own, so the time held for them never blocks them,
    // while a stranger without the link's token still cannot take it.
    // The holder's own list shows the time held for them; everyone else's does not.
    const { listAvailabilityDetailed } = await import("@/server/appointment-repository");
    const around = { clinicSlug: "lotus-dental", locationId, serviceId, practitionerId: time.personId, from: new Date(new Date(time.startsAt).getTime() - 60_000).toISOString(), to: new Date(new Date(time.startsAt).getTime() + 3_600_000).toISOString() };
    const strangerList = await listAvailabilityDetailed(around);
    expect(strangerList.slots.some((entry) => entry.startsAt === time.startsAt)).toBe(false);
    const holderList = await listAvailabilityDetailed({ ...around, holdToken: link.searchParams.get("hold")! });
    expect(holderList.slots.some((entry) => entry.startsAt === time.startsAt)).toBe(true);
    const { createSlotHold } = await import("@/server/slot-holds");
    const place = { clinicSlug: "lotus-dental", locationId, serviceId, practitionerId: time.personId, startsAt: time.startsAt, endsAt: time.endsAt };
    await expect(createSlotHold(place)).rejects.toMatchObject({ status: 409 });
    const theirs = await createSlotHold({ ...place, replaceToken: link.searchParams.get("hold")! });
    expect(theirs.holdToken).not.toBe(link.searchParams.get("hold"));
  });

  it("refuses staff tools without a key and with the wrong scope", async () => {
    const anonymous = await callTool(await connect(), "list_todays_bookings");
    expect(anonymous.error).toBe(true);
    expect(anonymous.data.code).toBe("invalid_api_key");
    const garbage = await callTool(await connect(`kal_live_${"a".repeat(43)}`), "list_todays_bookings");
    expect(garbage.data.code).toBe("invalid_api_key");

    const reader = await connect(readKey);
    const today = await callTool(reader, "list_todays_bookings");
    expect(today.error).toBe(false);
    expect(Array.isArray(today.data.bookings)).toBe(true);
    const cancel = await callTool(reader, "cancel_booking", { appointmentId: "appt_whatever", reason: "no reason" });
    expect(cancel.error).toBe(true);
    expect(cancel.data.code).toBe("insufficient_scope");
    const note = await callTool(reader, "add_booking_note", { appointmentId: "appt_whatever", note: "hello" });
    expect(note.data.code).toBe("insufficient_scope");
  });

  it("refuses the staff tools on a plan without the API, while the public tools stay open", async () => {
    const [before] = await owner<{ plan_key: string; status: string }[]>`select plan_key, status from tenant_subscriptions where tenant_id = ${tenantA}`;
    await owner`update tenant_subscriptions set plan_key = 'free', status = 'free' where tenant_id = ${tenantA}`;
    try {
      const refused = await callTool(await connect(readKey), "list_todays_bookings");
      expect(refused.error).toBe(true);
      expect(refused.data.code).toBe("plan_limit");
      const open = await callTool(await connect(), "list_services", { business: "lotus-dental" });
      expect(open.error).toBe(false);
    } finally {
      await owner`update tenant_subscriptions set plan_key = ${before!.plan_key}, status = ${before!.status} where tenant_id = ${tenantA}`;
    }
  });

  it("lets a write key list, note, move and cancel, and keeps other businesses out", async () => {
    const found = await callTool(await connect(), "find_open_times", { business: "lotus-dental", serviceId, from: new Date(Date.now() + 3 * 86_400_000).toISOString(), to: new Date(Date.now() + 4 * 86_400_000).toISOString() });
    const [first, second] = found.data.times as Array<{ startsAt: string; personId: string }>;
    const booking = await bookAppointment(keyContext, {
      serviceId, staffId: first!.personId, startsAt: first!.startsAt,
      customer: { firstName: "Mcptest", lastName: "Customer", phone: "+91 90000 00789", email: "mcptest@example.com" },
    }, `mcp-test-${randomUUID()}`);

    const writer = await connect(writeKey);
    const noted = await callTool(writer, "add_booking_note", { appointmentId: booking.id, note: "Prefers the quiet room" });
    expect(noted.error).toBe(false);
    expect(noted.data.notes).toBe("Prefers the quiet room");

    const moved = await callTool(writer, "reschedule_booking", { appointmentId: booking.id, startsAt: second!.startsAt });
    expect(moved.error).toBe(false);
    expect(new Date(moved.data.startsAt).toISOString()).toBe(new Date(second!.startsAt).toISOString());

    const stranger = await connect(otherKey);
    const hidden = await callTool(stranger, "cancel_booking", { appointmentId: booking.id, reason: "Not mine to cancel" });
    expect(hidden.error).toBe(true);
    expect(hidden.data.code).toBe("appointment_not_found");

    const cancelled = await callTool(writer, "cancel_booking", { appointmentId: booking.id, reason: "Customer called" });
    expect(cancelled.error).toBe(false);
    expect(cancelled.data.status).toBe("cancelled");
  });

  it("counts starts per network and refuses past the limit", async () => {
    const client = await connect();
    const attempts: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const result = await callTool(client, "start_booking", { business: "lotus-dental", serviceId, personId: practitionerId, startsAt: "2031-01-01T03:07:00.000Z" });
      attempts.push(result.data.code);
    }
    expect(attempts.slice(0, 10).every((code) => code === "slot_unavailable")).toBe(true);
    expect(attempts.slice(10)).toEqual(["rate_limited", "rate_limited"]);
  });
});
