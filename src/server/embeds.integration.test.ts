/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { afterAll, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAppointment } from "@/server/appointment-repository";
import { afterBookingRedirect, checkSummaryToken } from "@/server/after-booking";
import { createBookingLink, deleteBookingLink, followBookingLink, listBookingLinks } from "@/server/booking-links";
import { getTrackingSettings, publicTracking, saveTrackingSettings } from "@/server/embed-tracking";
import { emailTimesFor } from "@/server/email-times";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, plusMinutes, startIn, type SchedulingFixture } from "@/server/testing/scheduling-fixture";
import { bookingLinkInputSchema } from "@/lib/booking-links";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";
const link = (extra: Record<string, unknown> = {}) => bookingLinkInputSchema.parse({ label: "Reception card", ...extra });

describeScratch("embeds and conversion against a real database (feature 52)", () => {
  const fixtures: SchedulingFixture[] = [];
  afterAll(async () => {
    for (const fixture of fixtures) {
      await fixture.owner`delete from booking_short_links where tenant_id in (${fixture.tenantId}, ${fixture.otherTenantId})`;
      await fixture.owner`delete from tracking_settings where tenant_id in (${fixture.tenantId}, ${fixture.otherTenantId})`;
      await fixture.owner`delete from audit_events where tenant_id = ${fixture.tenantId} and action like 'settings.short_link.%' or action = 'settings.tracking.updated'`;
      await fixture.cleanup();
    }
  });
  const make = async (options: Parameters<typeof createSchedulingFixture>[1]) => {
    const fixture = await createSchedulingFixture(ownerUrl, options);
    fixtures.push(fixture);
    return fixture;
  };

  it("makes a short link, opens the right page with the campaign tag, counts the visit and keeps businesses apart", async () => {
    const fixture = await make({ name: "Links" });
    const [service] = await fixture.owner<{ slug: string }[]>`select slug from services where id = ${fixture.serviceId}`;
    const made = await createBookingLink(fixture.context, link({ serviceSlug: service!.slug, utmSource: "instagram", utmCampaign: "diwali" }));
    expect(made.code).toMatch(/^[a-z2-9]{7}$/);
    expect(made.targetPath).toBe(`/book/lotus-dental/${service!.slug}?utm_source=instagram&utm_campaign=diwali`);
    expect(await followBookingLink(made.code)).toBe(made.targetPath);
    expect(await followBookingLink(made.code)).toBe(made.targetPath);
    const [mine] = await listBookingLinks(fixture.context);
    expect(mine).toMatchObject({ id: made.id, clicks: 2 });
    // The other business sees none of it and cannot delete it.
    expect(await listBookingLinks(fixture.outsider)).toEqual([]);
    await expect(deleteBookingLink(fixture.outsider, made.id)).rejects.toMatchObject({ status: 404 });
    // Unknown codes and bad shapes open nothing and cost no query.
    expect(await followBookingLink("zzzzzzz")).toBeNull();
    expect(await followBookingLink("not-a-code")).toBeNull();
    // A service that does not exist is refused with a field error.
    await expect(createBookingLink(fixture.context, link({ serviceSlug: "no-such-service" }))).rejects.toMatchObject({ status: 422 });
    // Deleting stops the link at once.
    await deleteBookingLink(fixture.context, made.id);
    expect(await followBookingLink(made.code)).toBeNull();
  });

  it("stops a paused business's short link and writes no label into the audit trail", async () => {
    const fixture = await make({ name: "Paused links" });
    const made = await createBookingLink(fixture.context, link({ label: "Secret Label 9x" }));
    const audit = await fixture.owner`select metadata::text as text from audit_events where tenant_id = ${fixture.tenantId} and action = 'settings.short_link.created'`;
    expect(audit.some((row) => String(row.text).includes("Secret Label"))).toBe(false);
    await fixture.owner`update tenants set paused_at = now() where id = ${fixture.tenantId}`;
    try {
      expect(await followBookingLink(made.code)).toBeNull();
    } finally {
      await fixture.owner`update tenants set paused_at = null where id = ${fixture.tenantId}`;
    }
    expect(await followBookingLink(made.code)).toBe(made.targetPath);
  });

  it("saves tracking ids with a version check, rejects bad ids in the database too, and shows them only to their business", async () => {
    const fixture = await make({ name: "Tracking" });
    expect((await getTrackingSettings(fixture.context)).version).toBe(0);
    const saved = await saveTrackingSettings(fixture.context, { googleAnalyticsId: "G-ABC123XYZ", tagManagerId: null, metaPixelId: "123456789012345", plausibleDomain: null, expectedVersion: 0 });
    expect(saved).toMatchObject({ metaPixelId: "123456789012345", version: 1 });
    await expect(saveTrackingSettings(fixture.context, { googleAnalyticsId: null, tagManagerId: null, metaPixelId: null, plausibleDomain: null, expectedVersion: 0 })).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    expect((await publicTracking(fixture.tenantId))?.metaPixelId).toBe("123456789012345");
    expect(await publicTracking(fixture.otherTenantId)).toBeNull();
    expect(await getTrackingSettings(fixture.outsider)).toMatchObject({ metaPixelId: null, version: 0 });
    // The database refuses script code even if the application check were skipped.
    await expect(fixture.owner`update tracking_settings set meta_pixel_id = '<script>' where tenant_id = ${fixture.tenantId}`).rejects.toThrow();
    // The audit row says which providers are on, never the ids.
    const audit = await fixture.owner`select metadata::text as text from audit_events where tenant_id = ${fixture.tenantId} and action = 'settings.tracking.updated'`;
    expect(audit.map((row) => String(row.text)).join("")).not.toContain("123456789012345");
    // Clearing every id turns tracking off for the public page.
    await saveTrackingSettings(fixture.context, { googleAnalyticsId: null, tagManagerId: null, metaPixelId: null, plausibleDomain: null, expectedVersion: 1 });
    expect(await publicTracking(fixture.tenantId)).toBeNull();
  });

  it("sends a customer to the business's thank-you page with the booking id, and only passes details when the service says so", async () => {
    const fixture = await make({ name: "Redirect", service: { redirect_url: "https://shop.example.com/thanks?src=kalendr", after_booking: "redirect", pass_details_on_redirect: true } });
    const start = startIn(14, 10);
    const booked = await createAppointment(fixture.bookingInput(start, plusMinutes(start, 30), "redirect@acme-corp.in"), randomUUID(), randomUUID().replaceAll("-", ""));
    const { url } = await afterBookingRedirect(booked.manageToken);
    const target = new URL(url!);
    expect(target.origin + target.pathname).toBe("https://shop.example.com/thanks");
    expect(target.searchParams.get("src")).toBe("kalendr");
    expect(target.searchParams.get("kalendr_booking")).toBe(booked.appointmentId);
    expect(target.searchParams.get("kalendr_service")).toBe(fixture.serviceId);
    expect(url).not.toMatch(/redirect@acme|Fixture|Customer|%2B91|\+91/);
    const summary = checkSummaryToken(target.searchParams.get("kalendr_token")!);
    expect(summary).toMatchObject({ bookingId: booked.appointmentId, serviceId: fixture.serviceId });
    expect(() => checkSummaryToken(`${target.searchParams.get("kalendr_token")}x`)).toThrow();

    // Without "pass details" the address carries the booking id and nothing else of ours.
    await fixture.owner`update services set pass_details_on_redirect = false where id = ${fixture.serviceId}`;
    const bare = new URL((await afterBookingRedirect(booked.manageToken)).url!);
    expect([...bare.searchParams.keys()].sort()).toEqual(["kalendr_booking", "src"]);

    // A service that shows Kalendr's confirmation redirects nowhere; an unknown manage link is a plain 404.
    await fixture.owner`update services set after_booking = 'kalendr_page' where id = ${fixture.serviceId}`;
    expect((await afterBookingRedirect(booked.manageToken)).url).toBeNull();
    await expect(afterBookingRedirect("no-such-manage-token")).rejects.toMatchObject({ status: 404 });
    // The database will not store a redirect without an address.
    await expect(fixture.owner`update services set after_booking = 'redirect', redirect_url = null where id = ${fixture.serviceId}`).rejects.toThrow();
    await fixture.owner`delete from outbox_events where aggregate_id = ${booked.appointmentId}`;
    await fixture.owner`delete from audit_events where appointment_id = ${booked.appointmentId}`;
    await fixture.owner`delete from appointments where id = ${booked.appointmentId}`;
  });

  it("lists the next open times for an email, each linking to the booking page with that time chosen", async () => {
    const fixture = await make({ name: "Email times" });
    const view = await emailTimesFor(fixture.context, fixture.serviceId);
    expect(view.times.length).toBeGreaterThan(0);
    expect(view.times.length).toBeLessThanOrEqual(6);
    const first = new URL(view.times[0]!.href);
    expect(first.pathname).toMatch(/^\/book\/lotus-dental\//);
    expect(first.searchParams.get("time")).toBe(view.times[0]!.startsAt);
    expect(first.searchParams.get("date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(view.html).toContain("<a href=");
    await expect(emailTimesFor(fixture.outsider, fixture.serviceId)).rejects.toMatchObject({ status: 404 });
  });
});
