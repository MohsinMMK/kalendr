/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { listAvailability } from "@/server/appointment-repository";
import { ApiError } from "@/server/api-error";
import { joinWaitlist } from "@/server/waitlist-join";
import { getWaitlistOffers, offerByHand, setOrderRule, setServiceAutomatic, withdrawOffer } from "@/server/waitlist-staff";
import { localCaptureSink, type MessageSink, type OutgoingMessage } from "@/worker/delivery";
import { createHandlers } from "@/worker/handlers";
import { sweepWaitlist } from "@/worker/jobs";
import { providerSink } from "@/worker/delivery";
import { createEmailAdapter } from "@/worker/email-adapter";
import { createWhatsAppAdapter } from "@/worker/whatsapp-adapter";
import { createCaptureChannel } from "@/server/channels/capture";
import { createFakeEmailProvider } from "@/server/messaging/email-fake";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

const DAY = 86_400_000;
const dayKey = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * DAY));
const at = (offsetDays: number, hour: number) => new Date(`${dayKey(offsetDays)}T${String(hour).padStart(2, "0")}:00:00.000+05:30`);

async function expectApiError(promise: Promise<unknown>, code: string): Promise<ApiError> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  return error as ApiError;
}

describeIsolated("waitlist: joining, offering by hand, delivery and erasure (feature 21)", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let fixture: TenantFixture;
  const sent: OutgoingMessage[] = [];
  /** How many of the next deliveries behave like a bounced address. */
  let suppressNext = 0;
  const sink: MessageSink = {
    mode: "local_capture",
    async deliver(tenantDb, message, now) {
      if (message.tenantId !== fixture.tenantId) return "delivered";
      sent.push(message);
      if (suppressNext > 0) {
        suppressNext -= 1;
        // What the provider sink records for a bounced address: finished, but not sent.
        await tenantDb`insert into notifications (tenant_id, appointment_id, channel, template_key, destination_ciphertext, semantic_key, status, scheduled_at, failure_code)
          values (${message.tenantId}, null, ${message.channel}, ${message.message.templateKey}, 'x', ${message.message.semanticKey.replace(/^local:[a-z]+:/, `${message.channel}:`)}, 'cancelled', ${now}, 'suppressed_bounced')`;
        return "delivered";
      }
      return localCaptureSink.deliver(tenantDb, message, now);
    },
  };
  const drain = () => drainTenantOutbox(worker, fixture.tenantId, createHandlers({ sink, now: () => new Date(), origin: "https://app.example.test", available: { whatsapp: true, sms: true } }));

  async function person(label: string, preferred: "email" | "whatsapp" | "sms", consent: boolean): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel, messaging_consent_at)
      values (${fixture.tenantId}, ${label}, 'Waiter', ${`+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`}, ${`${label}-${randomUUID().slice(0, 6)}@example.com`}, ${preferred}, ${consent ? new Date() : null}) returning id`;
    return row!.id;
  }
  async function entryFor(patientId: string): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      insert into waitlist_entries (tenant_id, patient_id, service_id, location_id, date_from, date_to, time_preference)
      values (${fixture.tenantId}, ${patientId}, ${fixture.serviceId}, ${fixture.locationId}, ${dayKey(1)}, ${dayKey(30)}, 'any') returning id`;
    return row!.id;
  }
  const visible = async (start: Date) => (await listAvailability({
    clinicSlug: fixture.slug, locationId: fixture.locationId, serviceId: fixture.serviceId, practitionerId: fixture.practitionerId,
    from: new Date(start.getTime() - 60_000).toISOString(), to: new Date(start.getTime() + 61 * 60_000).toISOString(),
  })).some((slot) => slot.startsAt === start.toISOString());
  const reset = async () => {
    sent.length = 0;
    suppressNext = 0;
    await owner`delete from slot_offers where tenant_id = ${fixture.tenantId}`;
    await owner`delete from waitlist_entries where tenant_id = ${fixture.tenantId}`;
    await owner`delete from slot_holds where tenant_id = ${fixture.tenantId}`;
    await owner`update outbox_events set status = 'delivered' where tenant_id = ${fixture.tenantId} and status <> 'delivered'`;
  };
  const publicInput = (over: Record<string, unknown> = {}) => ({
    clinicSlug: fixture.slug, serviceId: fixture.serviceId, locationId: fixture.locationId, practitionerIds: [], dateFrom: dayKey(1), dateTo: dayKey(10),
    timePreference: "any", firstName: "Join", lastName: "Person", phone: "+919800011122", email: `join-${randomUUID().slice(0, 6)}@example.com`,
    preferredChannel: "email", messagingConsent: false, acceptedPrivacyNotice: true as const, ...over,
  }) as Parameters<typeof joinWaitlist>[0];

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 4, prepare: false });
    fixture = await createTenant(owner, "waitlist-staff");
    await owner`update services set duration_minutes = 60, slot_interval_minutes = 60, minimum_lead_minutes = 0, maximum_advance_days = 60 where id = ${fixture.serviceId}`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${fixture.locationId})`;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.locationId})`;
    await owner`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.serviceId})`;
    for (let day = 1; day <= 7; day += 1) {
      await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${fixture.tenantId}, ${fixture.locationId}, ${fixture.practitionerId}, ${day}, '00:00', '23:59', 'Asia/Kolkata', '2025-01-01', 60)`;
    }
    await owner`insert into workflow_settings (tenant_id, quiet_start_minute, quiet_end_minute) values (${fixture.tenantId}, 0, 0) on conflict (tenant_id) do update set quiet_start_minute = 0, quiet_end_minute = 0`;
  });
  afterAll(async () => {
    await owner?.end();
    await worker?.end();
  });

  it("puts a customer on the waitlist from the booking page, updates instead of duplicating, and refuses what the business does not offer", async () => {
    await reset();
    const input = publicInput();
    const joined = await joinWaitlist(input);
    expect(joined.updated).toBe(false);
    const [row] = await owner<{ status: string; time_preference: string; patient_id: string }[]>`select status, time_preference, patient_id from waitlist_entries where id = ${joined.entryId}`;
    expect(row).toMatchObject({ status: "active", time_preference: "any" });
    const [patient] = await owner<{ messaging_consent_at: Date | null; privacy_accepted_at: Date | null }[]>`select messaging_consent_at, privacy_accepted_at from patients where id = ${row!.patient_id}`;
    expect(patient?.privacy_accepted_at).toBeInstanceOf(Date);
    expect(patient?.messaging_consent_at).toBeNull();

    // The same person asking again for the same service updates the one entry.
    const again = await joinWaitlist({ ...input, timePreference: "morning", dateTo: dayKey(20), practitionerIds: [fixture.practitionerId] });
    expect(again).toEqual({ entryId: joined.entryId, updated: true });
    const [updated] = await owner<{ time_preference: string; preferred_practitioner_ids: string[] }[]>`select time_preference, preferred_practitioner_ids from waitlist_entries where id = ${joined.entryId}`;
    expect(updated).toMatchObject({ time_preference: "morning", preferred_practitioner_ids: [fixture.practitionerId] });

    await expectApiError(joinWaitlist(publicInput({ practitionerIds: [randomUUID()] })), "validation_error");
    await expectApiError(joinWaitlist(publicInput({ serviceId: randomUUID() })), "validation_error");
    await expectApiError(joinWaitlist(publicInput({ dateFrom: dayKey(-3), dateTo: dayKey(2) })), "validation_error");
    await expectApiError(joinWaitlist(publicInput({ dateFrom: dayKey(1), dateTo: dayKey(400) })), "validation_error");
    await expectApiError(joinWaitlist(publicInput({ clinicSlug: "no-such-business-here" })), "clinic_not_found");
    const audits = await owner<{ metadata: { entryId?: string } }[]>`select metadata from audit_events where tenant_id = ${fixture.tenantId} and action in ('waitlist.entry.joined', 'waitlist.entry.updated')`;
    expect(audits.map((audit) => audit.metadata.entryId)).toContain(joined.entryId);
    expect(JSON.stringify(audits)).not.toMatch(/@|\+91/);
  });

  it("lets staff offer a time by hand with the same hold, once per Idempotency-Key, and release it again", async () => {
    await reset();
    const waiting = await entryFor(await person("Hand", "email", false));
    const slot = at(4, 15);
    const context = staffContext(fixture);
    const key = randomUUID();
    const input = { practitionerId: fixture.practitionerId, startsAt: slot.toISOString(), endsAt: new Date(slot.getTime() + 3_600_000).toISOString() };
    expect(await visible(slot)).toBe(true);
    const first = await offerByHand(context, waiting, input, key);
    // The same key answers the same, and a double click makes one offer.
    expect(await offerByHand(context, waiting, input, key)).toEqual(first);
    expect((await owner<{ count: string }[]>`select count(*) from slot_offers where tenant_id = ${fixture.tenantId}`)[0]?.count).toBe("1");
    expect(await visible(slot)).toBe(false);
    const [offer] = await owner<{ origin: string; status: string }[]>`select origin, status from slot_offers where id = ${first.offerId}`;
    expect(offer).toMatchObject({ origin: "manual", status: "scheduled" });
    // Another person for the same time while one offer is live is refused, and so is the same person with a new key.
    const second = await entryFor(await person("Other", "email", false));
    await expectApiError(offerByHand(context, second, input, randomUUID()), "offer_not_possible");
    await expectApiError(offerByHand(context, waiting, input, randomUUID()), "offer_not_possible");

    await drain();
    const overview = await getWaitlistOffers(context);
    expect(overview.slots).toHaveLength(1);
    expect(overview.slots[0]).toMatchObject({ state: "live", practitionerName: "Dr Test", serviceName: "Check-up" });
    expect(overview.slots[0]?.offers[0]).toMatchObject({ personName: "Hand Waiter", status: "sent", origin: "manual", position: 1 });
    expect(JSON.stringify(overview)).not.toMatch(/@|\+91|token/i);

    await expect(withdrawOffer(context, first.offerId)).resolves.toEqual({ withdrawn: true });
    await expect(withdrawOffer(context, first.offerId)).resolves.toEqual({ withdrawn: false });
    expect(await visible(slot)).toBe(true);
    expect((await owner<{ status: string; ended_reason: string }[]>`select status, ended_reason from slot_offers where id = ${first.offerId}`)[0]).toEqual({ status: "withdrawn", ended_reason: "staff" });
    expect((await owner<{ status: string }[]>`select status from waitlist_entries where id = ${waiting}`)[0]?.status).toBe("active");

    // A time under two hours away is refused, and a person who is not on the list is a 404.
    const soon = new Date(Math.ceil((Date.now() + 40 * 60_000 - 30 * 60_000) / 3_600_000) * 3_600_000 + 30 * 60_000);
    await expectApiError(offerByHand(context, waiting, { practitionerId: fixture.practitionerId, startsAt: soon.toISOString(), endsAt: new Date(soon.getTime() + 3_600_000).toISOString() }, randomUUID()), "offer_not_possible");
    await expectApiError(offerByHand(context, randomUUID(), input, randomUUID()), "waitlist_not_found");
  });

  it("checks permission for every change, and records each change in the activity log", async () => {
    await reset();
    const nurse = staffContext(fixture, { role: "practitioner", permissions: resolvePermissions("practitioner", {}) });
    await expect(setOrderRule(nurse, "soonest_existing")).rejects.toMatchObject({ status: 403 });
    await expect(setServiceAutomatic(nurse, fixture.serviceId, false)).rejects.toMatchObject({ status: 403 });
    await expect(getWaitlistOffers(nurse)).rejects.toMatchObject({ status: 403 });
    const desk = staffContext(fixture, { role: "receptionist", permissions: resolvePermissions("receptionist", {}) });
    await expect(setOrderRule(desk, "soonest_existing")).resolves.toEqual({ orderRule: "soonest_existing" });
    await expect(setOrderRule(desk, "soonest_existing")).resolves.toEqual({ orderRule: "soonest_existing" });
    await expect(setServiceAutomatic(desk, fixture.serviceId, false)).resolves.toEqual({ serviceId: fixture.serviceId, automatic: false });
    await expectApiError(setServiceAutomatic(desk, randomUUID(), false), "service_not_found");
    const overview = await getWaitlistOffers(desk);
    expect(overview.orderRule).toBe("soonest_existing");
    expect(overview.services.find((service) => service.serviceId === fixture.serviceId)?.automatic).toBe(false);
    const audits = await owner<{ action: string }[]>`select action from audit_events where tenant_id = ${fixture.tenantId} and action like 'waitlist.%'`;
    expect(audits.map((audit) => audit.action)).toEqual(expect.arrayContaining(["waitlist.order_rule.changed", "waitlist.automation.changed"]));
    await setOrderRule(desk, "longest_waiting");
    await setServiceAutomatic(desk, fixture.serviceId, true);
  });

  it("sends the offer on WhatsApp to someone who agreed to it, by email to everyone else, and asks the next person when a message cannot be delivered", async () => {
    await reset();
    const waPatient = await person("Whats", "whatsapp", true);
    const smsPatient = await person("Texty", "sms", true);
    const noConsent = await person("Quiet", "whatsapp", false);
    const context = staffContext(fixture);
    const send = async (patientId: string, day: number) => {
      const entry = await entryFor(patientId);
      const start = at(day, 12);
      await offerByHand(context, entry, { practitionerId: fixture.practitionerId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString() }, randomUUID());
      await drain();
      return [...sent].reverse().find((message) => message.message.templateKey === "waitlist.offer");
    };
    expect((await send(waPatient, 5))?.channel).toBe("whatsapp");
    // The waitlist offer has no text-message template, so a customer who prefers text gets email, and so does one who did not consent.
    expect((await send(smsPatient, 6))?.channel).toBe("email");
    expect((await send(noConsent, 7))?.channel).toBe("email");
    const body = JSON.parse(sent.at(-1)!.message.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["minutes", "service", "url", "when"]);
    expect(String(body.url)).toMatch(/^https:\/\/app\.example\.test\/offer\//);

    // A bounced address: the message is skipped, the offer ends, and the next person is asked straight away.
    await reset();
    suppressNext = 1;
    const bounced = await entryFor(await person("Bounce", "email", false));
    const next = await entryFor(await person("Later", "email", false));
    const slot = at(8, 10);
    const mid = await owner<{ id: string }[]>`select id from waitlist_entries where id in (${bounced}, ${next})`;
    expect(mid).toHaveLength(2);
    await owner`update waitlist_entries set created_at = now() - interval '1 day' where id = ${bounced}`;
    const { offerSlot } = await import("@/server/waitlist-offers");
    const { postgresRunner } = await import("@/server/workflows/runner");
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
      await offerSlot(postgresRunner(transaction), fixture.tenantId, { locationId: fixture.locationId, serviceId: fixture.serviceId, practitionerId: fixture.practitionerId, startsAt: slot, endsAt: new Date(slot.getTime() + 3_600_000) });
    });
    await drain();
    const offers = await owner<{ entry_id: string; status: string; ended_reason: string | null; position: number }[]>`select entry_id, status, ended_reason, position from slot_offers where tenant_id = ${fixture.tenantId} order by position`;
    expect(offers[0]).toMatchObject({ entry_id: bounced, status: "withdrawn", ended_reason: "undeliverable", position: 1 });
    expect(offers[1]).toMatchObject({ entry_id: next, position: 2 });
    expect(await visible(slot)).toBe(false);
    // The second person was messaged normally and the time is still held for them.
    expect(offers[1]?.status).toBe("sent");
  });

  it("lets go of the held time when a customer's waitlist entries are erased, and keeps the sweep quiet when nothing is due", async () => {
    await reset();
    const patientId = await person("Erase", "email", false);
    const entry = await entryFor(patientId);
    const slot = at(9, 14);
    await offerByHand(staffContext(fixture), entry, { practitionerId: fixture.practitionerId, startsAt: slot.toISOString(), endsAt: new Date(slot.getTime() + 3_600_000).toISOString() }, randomUUID());
    expect(await visible(slot)).toBe(false);
    // The privacy erasure deletes the customer's entries; the offer goes with them and the time is public again at once.
    await owner`delete from waitlist_entries where id = ${entry}`;
    expect((await owner<{ count: string }[]>`select count(*) from slot_offers where tenant_id = ${fixture.tenantId}`)[0]?.count).toBe("0");
    expect(await visible(slot)).toBe(true);
    // The worker meets the leftover message event for an offer that no longer exists and finishes it without sending.
    const before = sent.length;
    await drain();
    expect(sent.length).toBe(before);
    await sweepWaitlist(worker);
    expect((await owner<{ count: string }[]>`select count(*) from slot_offers where tenant_id = ${fixture.tenantId}`)[0]?.count).toBe("0");
  });

  it("sends the offer through the real WhatsApp and email adapters, with the private link, to the right person only", async () => {
    await reset();
    const whatsapp = createCaptureChannel("whatsapp");
    const email = createFakeEmailProvider();
    const origin = "https://app.example.test";
    const handlers = createHandlers({
      sink: providerSink({
        whatsapp: createWhatsAppAdapter({ channel: whatsapp, origin, allowUnapproved: true }),
        email: createEmailAdapter({ provider: email, origin, fallbackReplyTo: null }),
      }),
      now: () => new Date(), origin, available: { whatsapp: true, sms: false }, allowUnapprovedTemplates: true,
    });
    const context = staffContext(fixture);
    const offerTo = async (patientId: string, day: number) => {
      const start = at(day, 13);
      await offerByHand(context, await entryFor(patientId), { practitionerId: fixture.practitionerId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString() }, randomUUID());
      await drainTenantOutbox(worker, fixture.tenantId, handlers);
    };
    await offerTo(await person("Wapp", "whatsapp", true), 10);
    expect(whatsapp.sent).toHaveLength(1);
    const message = whatsapp.sent[0]!;
    expect(message.content).toMatchObject({ kind: "template", templateKey: "waitlist_offer" });
    const variables = (message.content as { variables: string[] }).variables;
    expect(variables).toHaveLength(5);
    expect(variables[0]).toBe("Wapp");
    expect(variables[4]).toMatch(/^https:\/\/app\.example\.test\/offer\/[A-Za-z0-9_-]{40,}$/);
    expect(email.sent).toHaveLength(0);

    await offerTo(await person("Mail", "email", false), 11);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.subject).toMatch(/A time opened up at/);
    expect(email.sent[0]?.text).toMatch(/Take it within 15 minutes/);
    expect(email.sent[0]?.text).toMatch(/https:\/\/app\.example\.test\/offer\//);
    // The notification record names the channel and template, never the address, the number or the link.
    const notes = await owner<{ channel: string; template_key: string; destination_ciphertext: string }[]>`
      select channel, template_key, destination_ciphertext from notifications where tenant_id = ${fixture.tenantId} and template_key = 'waitlist.offer' and destination_ciphertext like 'provider:%'`;
    expect(notes.map((row) => row.channel).sort()).toEqual(["email", "whatsapp"]);
    expect(notes.every((row) => !/@|\+91|offer\//.test(row.destination_ciphertext))).toBe(true);
    // The sealed copy of the link is gone once sent.
    expect((await owner<{ count: string }[]>`select count(*) from slot_offers where tenant_id = ${fixture.tenantId} and token_sealed is not null`)[0]?.count).toBe("0");
  });
});
