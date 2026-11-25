/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { createScreenLink, createTicketLink, getQueueScreen, getQueueTicket, setTicketNotify } from "@/server/queue-screens";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const tokenOf = (path: string) => path.split("/").at(-1)!;

describeLocal("queue screen and phone links", () => {
  let owner: postgres.Sql;
  let tenantId = "";
  let locationId = "";
  let patientId = "";
  const appointmentIds: string[] = [];
  const ticketIds: string[] = [];
  const patientName = `Queuetest${randomUUID().slice(0, 6)}`;

  const staff = (): StaffContext => ({
    tenantId, clinicSlug: "lotus-dental", clinicName: "Lotus Dental Studio", role: "owner", permissions: resolvePermissions("owner", {}),
    membershipId: null, userId: null, userName: "Desk", userEmail: "test@example.com", preview: false,
  });

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    if (!tenant) throw new Error("Seed the isolated local database before this test");
    tenantId = tenant.id;
    // A location of its own, so the seeded queue doesn't change the numbers.
    const [location] = await owner<{ id: string }[]>`
      insert into locations (tenant_id, name, address, city, timezone)
      values (${tenantId}, 'Queue test room', '1 Test Road', 'Pune', 'Asia/Kolkata') returning id
    `;
    locationId = location!.id;
    const [practitioner] = await owner<{ id: string }[]>`select id from practitioners where tenant_id = ${tenantId} order by id limit 1`;
    const [service] = await owner<{ id: string }[]>`select id from services where tenant_id = ${tenantId} order by id limit 1`;
    const [patient] = await owner<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel) values (${tenantId}, ${patientName}, 'Walkin', '+919800000001', 'queue-test@example.com', 'sms') returning id
    `;
    patientId = patient!.id;
    for (const number of [1, 2, 3]) {
      const [appointment] = await owner<{ id: string }[]>`
        insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, checked_in_at)
        values (${tenantId}, ${locationId}, ${patientId}, ${practitioner!.id}, ${service!.id}, now(), now() + interval '15 minutes',
          'checked_in', 'walk_in', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, now())
        returning id
      `;
      appointmentIds.push(appointment!.id);
      const [ticket] = await owner<{ id: string }[]>`
        insert into queue_tickets (tenant_id, location_id, day, number, appointment_id)
        values (${tenantId}, ${locationId}, (now() at time zone 'Asia/Kolkata')::date, ${number}, ${appointment!.id})
        returning id
      `;
      ticketIds.push(ticket!.id);
    }
  });

  afterAll(async () => {
    if (!owner) return;
    await owner.begin(async (transaction) => {
      await transaction`delete from outbox_events where tenant_id = ${tenantId} and dedupe_key = any(${ticketIds.map((id) => `almost_next:${id}`)})`;
      await transaction`delete from audit_events where tenant_id = ${tenantId} and (appointment_id = any(${appointmentIds}) or metadata->>'locationId' = ${locationId})`;
      await transaction`delete from queue_displays where location_id = ${locationId}`;
      await transaction`delete from queue_tickets where location_id = ${locationId}`;
      await transaction`delete from appointments where location_id = ${locationId}`;
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id = ${patientId})`;
      await transaction`delete from patients where id = ${patientId}`;
      await transaction`delete from locations where id = ${locationId}`;
    }).catch((error: unknown) => console.error("queue test cleanup failed", error));
    await owner.end();
  });

  it("shows token numbers on the screen, never names, and a new link turns the old screen off", async () => {
    const first = tokenOf((await createScreenLink(staff(), { locationId })).path);
    const screen = await getQueueScreen(first);
    expect(screen).toMatchObject({ locationName: "Queue test room", next: [1, 2, 3], waitingCount: 3, calling: [] });
    expect(JSON.stringify(screen)).not.toContain(patientName);

    const second = tokenOf((await createScreenLink(staff(), { locationId })).path);
    await expect(getQueueScreen(first)).rejects.toMatchObject({ status: 404 });
    await expect(getQueueScreen(second)).resolves.toMatchObject({ waitingCount: 3 });

    const [audit] = await owner<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events where tenant_id = ${tenantId} and action = 'queue.screen_link_made' and metadata->>'locationId' = ${locationId} limit 1
    `;
    expect(JSON.stringify(audit?.metadata)).not.toContain(second);
  });

  it("tells a customer how many are ahead, with a rough wait, and no names", async () => {
    const token = tokenOf((await createTicketLink(staff(), ticketIds[2]!)).path);
    const ticket = await getQueueTicket(token);
    expect(ticket).toMatchObject({ number: 3, state: "waiting", ahead: 2, notifyWhenNext: false, notified: false, canNotify: true });
    expect(ticket.wait?.high).toBeGreaterThan(0);
    expect(JSON.stringify(ticket)).not.toContain(patientName);

    // Making the link again turns the earlier one off.
    const again = tokenOf((await createTicketLink(staff(), ticketIds[2]!)).path);
    await expect(getQueueTicket(token)).rejects.toMatchObject({ status: 404 });
    await expect(getQueueTicket(again)).resolves.toMatchObject({ number: 3 });
  });

  it("sends 'almost next' once, straight away when already close", async () => {
    const token = tokenOf((await createTicketLink(staff(), ticketIds[2]!)).path);
    const on = await setTicketNotify(token, { notifyWhenNext: true });
    expect(on).toMatchObject({ notifyWhenNext: true, notified: true });
    await setTicketNotify(token, { notifyWhenNext: false });
    await setTicketNotify(token, { notifyWhenNext: true });
    const rows = await owner<{ payload: { kind: string } }[]>`
      select payload from outbox_events where tenant_id = ${tenantId} and dedupe_key = ${`almost_next:${ticketIds[2]}`}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.kind).toBe("almost_next");
  });

  it("refuses bad, unknown and yesterday's links", async () => {
    await expect(getQueueTicket("short")).rejects.toMatchObject({ status: 404 });
    await expect(getQueueTicket("A".repeat(43))).rejects.toMatchObject({ status: 404 });
    await expect(getQueueScreen("../../etc")).rejects.toMatchObject({ status: 404 });
    const token = tokenOf((await createTicketLink(staff(), ticketIds[0]!)).path);
    await owner`update queue_tickets set day = day - 1 where id = ${ticketIds[0]!}`;
    await expect(getQueueTicket(token)).rejects.toMatchObject({ status: 404 });
    await expect(createTicketLink(staff(), ticketIds[0]!)).rejects.toMatchObject({ status: 404 });
  });
});
