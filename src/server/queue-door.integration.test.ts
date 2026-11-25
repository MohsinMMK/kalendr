/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { closeQueueDay, getJoinView, joinFromDoor, setupJoinLink } from "@/server/queue-door";
import { createScreenLink, getQueueScreen, getQueueTicket } from "@/server/queue-screens";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const tokenOf = (path: string) => path.split("/").at(-1)!;

describeLocal("door QR code and closing the queue", () => {
  let owner: postgres.Sql;
  let tenantId = "";
  let locationId = "";
  const firstName = `Door${randomUUID().slice(0, 6)}`;

  const staff = (): StaffContext => ({
    tenantId, clinicSlug: "lotus-dental", clinicName: "Lotus Dental Studio", role: "owner", permissions: resolvePermissions("owner", {}),
    membershipId: null, userId: null, userName: "Desk", userEmail: "test@example.com", preview: false,
  });

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    if (!tenant) throw new Error("Seed the isolated local database before this test");
    tenantId = tenant.id;
    const [location] = await owner<{ id: string }[]>`
      insert into locations (tenant_id, name, address, city, timezone)
      values (${tenantId}, 'Door test room', '1 Test Road', 'Pune', 'Asia/Kolkata') returning id
    `;
    locationId = location!.id;
    const [practitioner] = await owner<{ id: string }[]>`
      select practitioner.id from practitioners as practitioner
      join practitioner_services as offered on offered.tenant_id = practitioner.tenant_id and offered.practitioner_id = practitioner.id
      where practitioner.tenant_id = ${tenantId} and practitioner.is_active order by practitioner.id limit 1
    `;
    const [offered] = await owner<{ service_id: string }[]>`
      select service_id from practitioner_services where tenant_id = ${tenantId} and practitioner_id = ${practitioner!.id} limit 1
    `;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${practitioner!.id}, ${locationId})`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${offered!.service_id}, ${locationId})`;
  });

  afterAll(async () => {
    if (!owner) return;
    await owner.begin(async (transaction) => {
      const visits = await transaction<{ id: string }[]>`select id from appointments where location_id = ${locationId}`;
      const ids = visits.map((row) => row.id);
      await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id = any(${ids})`;
      await transaction`delete from audit_events where tenant_id = ${tenantId} and (appointment_id = any(${ids}) or metadata->>'locationId' = ${locationId})`;
      await transaction`delete from queue_tickets where location_id = ${locationId}`;
      await transaction`delete from queue_counters where location_id = ${locationId}`;
      await transaction`delete from queue_displays where location_id = ${locationId}`;
      await transaction`delete from resource_reservations where appointment_id = any(${ids})`;
      await transaction`delete from appointments where location_id = ${locationId}`;
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where tenant_id = ${tenantId} and first_name like ${`${firstName}%`})`;
      await transaction`delete from patients where tenant_id = ${tenantId} and first_name like ${`${firstName}%`}`;
      await transaction`delete from practitioner_locations where location_id = ${locationId}`;
      await transaction`delete from service_locations where location_id = ${locationId}`;
      await transaction`delete from locations where id = ${locationId}`;
    }).catch((error: unknown) => console.error("door test cleanup failed", error));
    await owner.end();
  });

  it("lets someone at the door join, gives them the next token, and shows the screen no name", async () => {
    const link = await setupJoinLink(staff(), { locationId, newLink: true });
    expect(link).toMatchObject({ selfJoinEnabled: true });
    const doorToken = tokenOf(link.link!.path);
    await expect(getJoinView(doorToken)).resolves.toMatchObject({ open: true, closed: false, waitingCount: 0, locationName: "Door test room" });

    const first = await joinFromDoor(doorToken, { firstName, phone: "+919811100001", notify: true });
    const second = await joinFromDoor(doorToken, { firstName: `${firstName}B`, phone: "+919811100002", notify: false });
    const mine = await getQueueTicket(tokenOf(first.ticketPath));
    expect(mine).toMatchObject({ number: 1, state: "waiting", ahead: 0, notifyWhenNext: true });
    await expect(getQueueTicket(tokenOf(second.ticketPath))).resolves.toMatchObject({ number: 2, ahead: 1 });
    await expect(getJoinView(doorToken)).resolves.toMatchObject({ waitingCount: 2 });

    const screen = await getQueueScreen(tokenOf((await createScreenLink(staff(), { locationId })).path));
    expect(screen).toMatchObject({ next: [1, 2], waitingCount: 2 });
    expect(JSON.stringify(screen)).not.toContain(firstName);
    // The visit is a checked-in walk-in, so Today shows it like any other.
    const [visit] = await owner<{ status: string; booking_source: string }[]>`
      select status, booking_source from appointments where location_id = ${locationId} order by created_at limit 1
    `;
    expect(visit).toMatchObject({ status: "checked_in", booking_source: "walk_in" });
  });

  it("keeps the door code working when the screen link is replaced, and a new door code turns the old one off", async () => {
    const [live] = await owner<{ join_token_hash: string | null }[]>`
      select join_token_hash from queue_displays where location_id = ${locationId} and revoked_at is null
    `;
    expect(live?.join_token_hash).toBeTruthy();
    const before = await setupJoinLink(staff(), { locationId });
    expect(before.link).toBeNull();
    const replaced = await setupJoinLink(staff(), { locationId, newLink: true });
    const [after] = await owner<{ join_token_hash: string | null }[]>`
      select join_token_hash from queue_displays where location_id = ${locationId} and revoked_at is null
    `;
    expect(after?.join_token_hash).not.toBe(live?.join_token_hash);
    await expect(getJoinView(tokenOf(replaced.link!.path))).resolves.toMatchObject({ open: true });
    await expect(getJoinView("x".repeat(40))).rejects.toMatchObject({ status: 404 });
    // Replacing the screen link carries the door code over.
    await createScreenLink(staff(), { locationId });
    await expect(getJoinView(tokenOf(replaced.link!.path))).resolves.toMatchObject({ open: true });
  });

  it("refuses door sign-ups while they are turned off", async () => {
    const link = await setupJoinLink(staff(), { locationId, newLink: true, selfJoinEnabled: false });
    const token = tokenOf(link.link!.path);
    await expect(getJoinView(token)).resolves.toMatchObject({ open: false, closed: false });
    await expect(joinFromDoor(token, { firstName: `${firstName}C`, phone: "+919811100003", notify: false })).rejects.toMatchObject({ status: 409, code: "self_join_off" });
    await setupJoinLink(staff(), { locationId, selfJoinEnabled: true });
    await expect(getJoinView(token)).resolves.toMatchObject({ open: true });
  });

  it("closes the day: those waiting are let go, the report counts them, and nobody new can join", async () => {
    const token = tokenOf((await setupJoinLink(staff(), { locationId, newLink: true })).link!.path);
    const report = await closeQueueDay(staff(), { locationId, reason: "Doctor called away" });
    expect(report).toMatchObject({ issued: 2, served: 0, left: 2 });
    const waiting = await owner<{ status: string }[]>`select status from appointments where location_id = ${locationId}`;
    expect(waiting.every((row) => row.status === "cancelled")).toBe(true);
    await expect(getJoinView(token)).resolves.toMatchObject({ open: false, closed: true });
    await expect(joinFromDoor(token, { firstName: `${firstName}D`, phone: "+919811100004", notify: false })).rejects.toMatchObject({ status: 409, code: "queue_day_closed" });
    const [audit] = await owner<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events where tenant_id = ${tenantId} and action = 'queue.day_closed' and metadata->>'locationId' = ${locationId}
    `;
    expect(JSON.stringify(audit?.metadata)).not.toContain("Doctor");
    // Closing again changes nothing.
    await expect(closeQueueDay(staff(), { locationId, reason: "Again" })).resolves.toMatchObject({ issued: 2, left: 2 });
  });
});
