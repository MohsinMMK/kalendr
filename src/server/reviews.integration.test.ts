/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { createAppointment, listAvailability, updateAppointmentStatus } from "@/server/appointment-repository";
import {
  getReviewStateByToken,
  listPublicReviews,
  listStaffReviews,
  loadRatingSummariesIn,
  saveReviewByToken,
  setReviewHidden,
} from "@/server/reviews";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname); // nira_local: a local cluster made before the rename (see scripts/local-db.sh)
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

describeLocal("customer reviews", () => {
  let owner: postgres.Sql;
  let tenantId = "";
  let otherTenantId = "";
  let appointmentId = "";
  let patientId = "";
  let practitionerId = "";
  let manageToken = "";

  const staff = (): StaffContext => ({
    tenantId,
    clinicSlug: "lotus-dental",
    clinicName: "Lotus Dental Studio",
    role: "owner",
    permissions: resolvePermissions("owner", {}),
    membershipId: null,
    userId: null,
    userName: "Test",
    userEmail: "test@example.com",
    preview: false,
  });

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [other] = await owner<{ id: string }[]>`select id from tenants where slug <> 'lotus-dental' order by slug limit 1`;
    if (!tenant || !other) throw new Error("Seed the isolated local database before this test");
    tenantId = tenant.id;
    otherTenantId = other.id;
    const [link] = await owner<{ location_id: string; service_id: string; practitioner_id: string }[]>`
      select location.location_id, service.service_id, service.practitioner_id
      from practitioner_services as service
      join practitioner_locations as location
        on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      where service.tenant_id = ${tenantId} limit 1
    `;
    practitionerId = link!.practitioner_id;
    const day = 24 * 60 * 60 * 1_000;
    const slots = await listAvailability({
      clinicSlug: "lotus-dental",
      locationId: link!.location_id,
      serviceId: link!.service_id,
      practitionerId,
      from: new Date(Date.now() + 30 * day).toISOString(),
      to: new Date(Date.now() + 37 * day).toISOString(),
    });
    const slot = slots.at(-2);
    if (!slot) throw new Error("Expected an open slot");
    const created = await createAppointment({
      clinicSlug: "lotus-dental",
      patientType: "new",
      bookingFor: "self",
      locationId: link!.location_id,
      serviceId: link!.service_id,
      practitionerId,
      slotId: randomUUID(),
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      firstName: "Reviewer",
      lastName: "Tester",
      phone: `+91 91${String(Date.now()).slice(-8)}`,
      email: `review-${randomUUID().slice(0, 8)}@example.com`,
      preferredChannel: "email",
      acceptedPrivacyNotice: true,
      messagingConsent: false,
    }, randomUUID(), randomUUID().replaceAll("-", ""));
    appointmentId = created.appointmentId;
    manageToken = created.manageToken;
    const [row] = await owner<{ patient_id: string }[]>`select patient_id from appointments where id = ${appointmentId}`;
    patientId = row!.patient_id;
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      await transaction`delete from reviews where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id = ${appointmentId}`;
      await transaction`delete from notifications where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`.catch(() => undefined);
      await transaction`delete from audit_events where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from resource_reservations where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`.catch(() => undefined);
      await transaction`delete from appointments where id = ${appointmentId}`;
      await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '5 minutes'`;
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id = ${patientId})`;
      await transaction`delete from patients where id = ${patientId}`;
    }).catch((error: unknown) => {
      console.error("review test cleanup failed", error);
    });
    await owner.end();
  });

  it("opens only once the appointment is finished", async () => {
    await expect(getReviewStateByToken(manageToken)).resolves.toEqual({ open: false, closesAt: null, review: null });
    await expect(saveReviewByToken(manageToken, { rating: 5 })).rejects.toMatchObject({ status: 409, code: "review_not_open" });
    await expect(saveReviewByToken("not-a-real-token", { rating: 5 })).rejects.toMatchObject({ status: 404 });
  });

  it("saves one review per appointment, lets the customer change it, and keeps the name short", async () => {
    // Finish the visit the way the front desk does: check in, then complete.
    const [membership] = await owner<{ user_id: string }[]>`
      select user_id from memberships where tenant_id = ${tenantId} and role = 'owner' and is_active limit 1
    `;
    const [current] = await owner<{ status: string; version: number }[]>`select status, version from appointments where id = ${appointmentId}`;
    let version = current!.version;
    if (current!.status === "requested") {
      version = (await updateAppointmentStatus(membership!.user_id, appointmentId, { status: "booked", expectedVersion: version })).version;
    }
    version = (await updateAppointmentStatus(membership!.user_id, appointmentId, { status: "checked_in", expectedVersion: version })).version;
    await updateAppointmentStatus(membership!.user_id, appointmentId, { status: "completed", expectedVersion: version });

    // The review request waits about two hours, and is queued once.
    const queued = await owner<{ event_type: string; minutes: number }[]>`
      select event_type, extract(epoch from (available_at - now())) / 60 as minutes
      from outbox_events where tenant_id = ${tenantId} and aggregate_id = ${appointmentId}
        and event_type = 'appointment.review_request'
    `;
    expect(queued).toHaveLength(1);
    expect(Number(queued[0]!.minutes)).toBeGreaterThan(110);
    expect(Number(queued[0]!.minutes)).toBeLessThanOrEqual(120);

    await expect(saveReviewByToken(manageToken, { rating: 9 })).rejects.toMatchObject({ status: 400 });

    const first = await saveReviewByToken(manageToken, { rating: 4, comment: "  Good visit  " });
    expect(first).toMatchObject({ open: true, review: { rating: 4, comment: "Good visit" } });
    const second = await saveReviewByToken(manageToken, { rating: 5 });
    expect(second.review).toEqual({ rating: 5, comment: null, visibility: "public" });

    const stored = await owner<{ display_name: string; practitioner_id: string }[]>`
      select display_name, practitioner_id from reviews where appointment_id = ${appointmentId}
    `;
    expect(stored).toEqual([{ display_name: "Reviewer T.", practitioner_id: practitionerId }]);

    const forPerson = await listPublicReviews(tenantId, { practitionerId });
    expect(forPerson.some((review) => review.displayName === "Reviewer T." && review.rating === 5)).toBe(true);
  });

  it("stays inside its own business under row-level security", async () => {
    const seenByOther = await withTenant(otherTenantId, (transaction) =>
      transaction.execute(sql`select id from reviews where appointment_id = ${appointmentId}`),
    );
    expect(seenByOther.length).toBe(0);
    const otherList = await listPublicReviews(otherTenantId, { limit: 50 });
    expect(otherList.some((review) => review.displayName === "Reviewer T.")).toBe(false);
  });

  it("lets staff hide a review from the public page and its ratings", async () => {
    const [review] = (await listStaffReviews(staff())).filter((item) => item.appointmentId === appointmentId);
    expect(review).toBeDefined();
    const before = await withTenant(tenantId, (transaction) => loadRatingSummariesIn(transaction, tenantId));

    await setReviewHidden(staff(), review!.id, true);
    const publicList = await listPublicReviews(tenantId, { limit: 50 });
    expect(publicList.some((item) => item.id === review!.id)).toBe(false);
    const after = await withTenant(tenantId, (transaction) => loadRatingSummariesIn(transaction, tenantId));
    expect(after.business.count).toBe(before.business.count - 1);

    await expect(setReviewHidden({ ...staff(), tenantId: otherTenantId }, review!.id, false)).rejects.toMatchObject({ status: 404 });
    await expect(
      setReviewHidden({ ...staff(), role: "receptionist", permissions: resolvePermissions("receptionist", {}) }, review!.id, false),
    ).rejects.toMatchObject({ status: 403 });

    await setReviewHidden(staff(), review!.id, false);
    const shown = await listPublicReviews(tenantId, { limit: 50 });
    expect(shown.some((item) => item.id === review!.id)).toBe(true);
  });
});
