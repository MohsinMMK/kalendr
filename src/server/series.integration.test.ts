/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { TZDate } from "@date-fns/tz";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { SeriesPreview, SeriesSaveResult } from "@/lib/series-contracts";
import type { RepeatRule } from "@/lib/series-rule";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { createCustomer, createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { ApiError } from "@/server/api-error";
import { createStaffAppointment, manageAppointment, mutateStaffAppointment, updateAppointmentStatus } from "@/server/appointment-repository";
import type { StaffBookingInput } from "@/server/contracts";
import { sha256 } from "@/server/crypto";
import { getSeriesView, previewSeries, saveSeries } from "@/server/series";
import { changeSeries, previewSeriesChange } from "@/server/series-change";
import { addDays, isoWeekday, localDateOf, localInstant } from "@/server/slot-engine/time";
import type { StaffContext } from "@/server/staff-context";
import { createCaptureChannel } from "@/server/channels/capture";
import { createFakeEmailProvider } from "@/server/messaging/email-fake";
import { localCaptureSink, providerSink, type MessageSink, type OutgoingMessage } from "@/worker/delivery";
import { createEmailAdapter } from "@/worker/email-adapter";
import { createWhatsAppAdapter } from "@/worker/whatsapp-adapter";
import { createHandlers } from "@/worker/handlers";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

const weekly = (count: number, over: Partial<RepeatRule> = {}): RepeatRule => ({ frequency: "weekly", interval: 1, weekdays: [], end: { kind: "count", count }, ...over });

async function expectApiError(promise: Promise<unknown>, code: string): Promise<ApiError> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  return error as ApiError;
}

interface Place {
  fixture: TenantFixture;
  context: StaffContext;
  patientId: string;
  zone: string;
}

/** The first date at least `minDays` ahead that falls on this ISO weekday (1 Monday to 7 Sunday), as read in `zone`. */
function nextWeekday(zone: string, weekday: number, minDays = 3): string {
  let date = localDateOf(Date.now(), zone);
  for (let guard = 0; guard < 400; guard += 1) {
    date = addDays(date, 1);
    if (isoWeekday(date) === weekday && new Date(localInstant(date, "00:00", zone)).getTime() > Date.now() + minDays * 86_400_000) return date;
  }
  throw new Error("no date");
}

describeIsolated("repeating appointments (feature 17)", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let runtime: postgres.Sql;
  let kolkata: Place;
  let london: Place;
  let other: Place;
  const sent: OutgoingMessage[] = [];
  const sink: MessageSink = {
    mode: "local_capture",
    async deliver(tenantDb, message, now) {
      sent.push(message);
      return localCaptureSink.deliver(tenantDb, message, now);
    },
  };
  const drain = (place: Place) => drainTenantOutbox(worker, place.fixture.tenantId, createHandlers({ sink, now: () => new Date(), origin: "https://app.example.test", available: { whatsapp: true, sms: true } }));

  async function setup(label: string, zone: string): Promise<Place> {
    const fixture = await createTenant(owner, label);
    await owner`update tenants set timezone = ${zone} where id = ${fixture.tenantId}`;
    await owner`update locations set timezone = ${zone} where id = ${fixture.locationId}`;
    await owner`update services set duration_minutes = 60, slot_interval_minutes = 60, minimum_lead_minutes = 0, maximum_advance_days = 500 where id = ${fixture.serviceId}`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${fixture.locationId})`;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.locationId})`;
    await owner`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.serviceId})`;
    for (let day = 1; day <= 7; day += 1) {
      await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${fixture.tenantId}, ${fixture.locationId}, ${fixture.practitionerId}, ${day}, '08:00', '18:00', ${zone}, '2025-01-01', 60)`;
    }
    const [user] = await owner<{ id: string }[]>`insert into auth_users (name, email, email_verified) values (${`Staff ${label}`}, ${`staff-${randomUUID().slice(0, 8)}@example.com`}, true) returning id`;
    await owner`insert into memberships (tenant_id, user_id, role) values (${fixture.tenantId}, ${user!.id}, 'owner')`;
    const patient = await createCustomer(owner, fixture.tenantId, { firstName: "Series", lastName: "Customer" });
    await owner`update patients set preferred_channel = 'email' where id = ${patient.id}`;
    return { fixture, patientId: patient.id, zone, context: staffContext(fixture, { userId: user!.id }) };
  }

  const bookingFor = (place: Place, date: string, time: string, over: Partial<StaffBookingInput> = {}): StaffBookingInput => ({
    clinicSlug: place.fixture.slug, locationId: place.fixture.locationId, serviceId: place.fixture.serviceId, practitionerId: place.fixture.practitionerId,
    startsAt: new Date(localInstant(date, time, place.zone)).toISOString(), source: "desk", patientId: place.patientId, ...over,
  });
  const save = (place: Place, date: string, rule: RepeatRule, resolutions: Array<{ index: number; action: "skip" | "move"; startsAt?: string }> = [], over: Partial<StaffBookingInput> = {}) =>
    saveSeries(place.context, { booking: bookingFor(place, date, "10:00", over), rule, resolutions }, `series-${randomUUID()}`);
  const savedOf = (result: SeriesSaveResult) => {
    if (!result.saved) throw new Error(`not saved: ${JSON.stringify(result.preview.visits.filter((visit) => visit.state === "clash").map((visit) => [visit.index, visit.reason]))}`);
    return result;
  };
  const visitsOf = (place: Place, seriesId: string) => owner<{ id: string; series_index: number; status: string; starts_at: Date; version: number }[]>`
    select id, series_index, status, starts_at, version from appointments where tenant_id = ${place.fixture.tenantId} and series_id = ${seriesId} order by series_index`;
  const counts = async (place: Place) => {
    const [row] = await owner<{ series: number; appointments: number; events: number }[]>`
      select (select count(*)::int from appointment_series where tenant_id = ${place.fixture.tenantId}) as series,
        (select count(*)::int from appointments where tenant_id = ${place.fixture.tenantId}) as appointments,
        (select count(*)::int from outbox_events where tenant_id = ${place.fixture.tenantId}) as events`;
    return row!;
  };
  /** A booking made by someone else, to make a time busy. */
  async function blockTime(place: Place, date: string, time: string): Promise<string> {
    const booked = await createStaffAppointment(place.context, bookingFor(place, date, time, { patientId: undefined, newPatient: { firstName: "Someone", lastName: "Else", phone: "+919800000111", email: "", preferredChannel: "email", isDependent: false, messagingConsent: false } }), `block-${randomUUID()}`, randomUUID());
    return booked.appointmentId;
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 3, prepare: false });
    worker = postgres(workerUrl!, { max: 4, prepare: false });
    runtime = postgres(runtimeUrl!, { max: 3, prepare: false });
    kolkata = await setup("series-in", "Asia/Kolkata");
    london = await setup("series-uk", "Europe/London");
    other = await setup("series-other", "Asia/Kolkata");
  });
  afterAll(async () => {
    await owner?.end();
    await worker?.end();
    await runtime?.end();
  });

  it("books 'every Tuesday at 10 am for 8 weeks' in one action, with one clash offered another time", async () => {
    const start = nextWeekday("Asia/Kolkata", 2);
    const third = addDays(start, 14);
    await blockTime(kolkata, third, "10:00");
    const before = await counts(kolkata);

    const preview = await previewSeries(kolkata.context, bookingFor(kolkata, start, "10:00"), weekly(8));
    expect(preview.visits).toHaveLength(8);
    expect(preview.freeCount).toBe(7);
    expect(preview.clashCount).toBe(1);
    expect(await counts(kolkata)).toEqual(before); // the preview saved nothing
    const clash = preview.visits.find((visit) => visit.state === "clash")!;
    expect(clash.index).toBe(3);
    expect(clash.date).toBe(third);
    expect(clash.reason).toBe("already_booked");
    expect(clash.reasonLabel).toBe("Already booked");
    expect(clash.alternatives.length).toBeGreaterThan(0);
    expect(clash.alternatives.every((slot) => localDateOf(new Date(slot.startsAt).getTime(), "Asia/Kolkata") === third)).toBe(true);
    expect(clash.alternatives.some((slot) => slot.startsAt === clash.startsAt)).toBe(false);

    const alternative = clash.alternatives.find((slot) => slot.startsAt === new Date(localInstant(third, "11:00", "Asia/Kolkata")).toISOString())!;
    expect(alternative).toBeTruthy();
    const result = savedOf(await save(kolkata, start, weekly(8), [{ index: 3, action: "move", startsAt: alternative.startsAt }]));
    expect(result.visitCount).toBe(8);
    expect(result.skippedCount).toBe(0);

    const visits = await visitsOf(kolkata, result.seriesId);
    expect(visits.map((visit) => Number(visit.series_index))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(visits.every((visit) => visit.status === "booked")).toBe(true);
    const clocks = visits.map((visit) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(visit.starts_at));
    expect(clocks).toEqual(["10:00", "10:00", "11:00", "10:00", "10:00", "10:00", "10:00", "10:00"]);
    const [series] = await owner<{ rule_text: string; occurrence_count: number | null; status: string; starts_on: string; time_of_day: string }[]>`
      select rule_text, occurrence_count, status, starts_on::text, time_of_day from appointment_series where id = ${result.seriesId}`;
    expect(series).toMatchObject({ occurrence_count: 8, status: "active", starts_on: start, time_of_day: "10:00" });
    expect(series!.rule_text).toContain("FREQ=WEEKLY");
    const [audit] = await owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where tenant_id = ${kolkata.fixture.tenantId} and action = 'series.created' order by occurred_at desc limit 1`;
    expect(audit!.metadata).toMatchObject({ seriesId: result.seriesId, visits: 8, skipped: 0 });
    expect(Object.keys(audit!.metadata).sort()).toEqual(["seriesId", "skipped", "visits"]);

    const view = await getSeriesView(kolkata.context, result.seriesId);
    expect(view.visits).toHaveLength(8);
    expect(view.summary).toBe("Every Tuesday at 10:00 am for 8 weeks");
  });

  it("lets staff skip a clashing visit, and an answer on the wrong day is refused", async () => {
    const start = nextWeekday("Asia/Kolkata", 3);
    await blockTime(kolkata, addDays(start, 7), "10:00");
    const skipped = savedOf(await save(kolkata, start, weekly(4), [{ index: 2, action: "skip" }]));
    expect(skipped).toMatchObject({ visitCount: 3, skippedCount: 1 });
    expect((await visitsOf(kolkata, skipped.seriesId)).map((visit) => Number(visit.series_index))).toEqual([1, 3, 4]);

    const thursday = nextWeekday("Asia/Kolkata", 4);
    const wrongDay = new Date(localInstant(addDays(thursday, 8), "10:00", "Asia/Kolkata")).toISOString();
    const before = await counts(kolkata);
    await expectApiError(save(kolkata, thursday, weekly(3), [{ index: 2, action: "move", startsAt: wrongDay }]), "validation_error");
    await expectApiError(save(kolkata, thursday, weekly(3), [{ index: 9, action: "skip" }]), "validation_error");
    expect(await counts(kolkata)).toEqual(before);
  });

  it("saves nothing when a visit fails at commit, and shows the list again with that visit marked", async () => {
    const start = nextWeekday("Asia/Kolkata", 4);
    await blockTime(kolkata, addDays(start, 21), "10:00");
    const before = await counts(kolkata);
    const result = await save(kolkata, start, weekly(6));
    expect(result.saved).toBe(false);
    if (result.saved) throw new Error("unreachable");
    expect(result.preview.visits.find((visit) => visit.index === 4)).toMatchObject({ state: "clash", reason: "already_booked" });
    expect(result.preview.visits.filter((visit) => visit.state === "free")).toHaveLength(5);
    expect(await counts(kolkata)).toEqual(before); // no series, no visit, no message event
  });

  it("moving 'this and following' from visit 4 to Wednesday leaves visits 1 to 3 alone", async () => {
    const kolkata = await setup("series-follow", "Asia/Kolkata");
    const start = nextWeekday("Asia/Kolkata", 2, 5);
    const saved = savedOf(await save(kolkata, start, weekly(8)));
    const original = await visitsOf(kolkata, saved.seriesId);
    expect(original).toHaveLength(8);
    const view = await getSeriesView(kolkata.context, saved.seriesId);
    const fourth = original[3]!;
    const wednesday = addDays(localDateOf(fourth.starts_at.getTime(), "Asia/Kolkata"), 1);
    const newStart = new Date(localInstant(wednesday, "10:00", "Asia/Kolkata")).toISOString();

    const preview = await previewSeriesChange(kolkata.context, saved.seriesId, { scope: "following", fromAppointmentId: fourth.id, expectedVersion: view.version, startsAt: newStart });
    expect(preview.visits).toHaveLength(5);
    expect(preview.visits.every((visit) => isoWeekday(visit.date) === 3 && visit.state === "free")).toBe(true);
    expect((await visitsOf(kolkata, saved.seriesId)).map((visit) => visit.status)).toEqual(original.map((visit) => visit.status)); // a preview changes nothing

    const key = `change-${randomUUID()}`;
    const input = { action: "change" as const, scope: "following" as const, fromAppointmentId: fourth.id, expectedVersion: view.version, startsAt: newStart, resolutions: [] };
    const changed = await changeSeries(kolkata.context, saved.seriesId, input, key);
    expect(changed).toMatchObject({ changed: true, cancelledCount: 5, bookedCount: 5, keptCount: 3 });
    if (!changed.changed || !changed.newSeriesId) throw new Error("unreachable");

    const after = await visitsOf(kolkata, saved.seriesId);
    expect(after.slice(0, 3).map((visit) => [visit.status, visit.version, visit.starts_at.getTime()])).toEqual(original.slice(0, 3).map((visit) => ["booked", visit.version, visit.starts_at.getTime()]));
    expect(after.slice(3).every((visit) => visit.status === "cancelled")).toBe(true);
    const next = await visitsOf(kolkata, changed.newSeriesId);
    expect(next.map((visit) => Number(visit.series_index))).toEqual([1, 2, 3, 4, 5]);
    expect(next.every((visit) => visit.status === "booked" && isoWeekday(localDateOf(visit.starts_at.getTime(), "Asia/Kolkata")) === 3)).toBe(true);
    expect(localDateOf(next[0]!.starts_at.getTime(), "Asia/Kolkata")).toBe(wednesday);
    const [oldSeries, newSeries] = await owner<{ id: string; status: string; until_on: string | null; occurrence_count: number | null; continued_from_id: string | null }[]>`
      select id, status, until_on::text, occurrence_count, continued_from_id from appointment_series where id in (${saved.seriesId}, ${changed.newSeriesId}) order by created_at`;
    expect(oldSeries).toMatchObject({ id: saved.seriesId, status: "ended", until_on: localDateOf(after[2]!.starts_at.getTime(), "Asia/Kolkata"), occurrence_count: null });
    expect(newSeries).toMatchObject({ id: changed.newSeriesId, status: "active", occurrence_count: 5, continued_from_id: saved.seriesId });

    // The same request again (a double click) changes nothing more; an old version is refused.
    expect(await changeSeries(kolkata.context, saved.seriesId, input, key)).toEqual(changed);
    await expectApiError(changeSeries(kolkata.context, saved.seriesId, input, `change-${randomUUID()}`), "version_conflict");
    expect((await owner`select id from appointment_series where continued_from_id = ${saved.seriesId}`).length).toBe(1);
  });

  it("changes 'all' from a later visit by moving every open visit by the same days, keeping the same dates for a time-only change", async () => {
    const place = await setup("series-all", "Asia/Kolkata");
    const start = nextWeekday("Asia/Kolkata", 2, 5);
    const saved = savedOf(await save(place, start, weekly(6)));
    const original = await visitsOf(place, saved.seriesId);
    const view = await getSeriesView(place.context, saved.seriesId);
    // Looking at visit 3, the time moves to 2 pm and the day stays: all six visits keep their dates and change time.
    const third = original[2]!;
    const newStart = new Date(localInstant(localDateOf(third.starts_at.getTime(), "Asia/Kolkata"), "14:00", "Asia/Kolkata")).toISOString();
    const changed = await changeSeries(place.context, saved.seriesId, { action: "change", scope: "all", fromAppointmentId: third.id, expectedVersion: view.version, startsAt: newStart, resolutions: [] }, `all-${randomUUID()}`);
    if (!changed.changed || !changed.newSeriesId) throw new Error("not changed");
    expect(changed).toMatchObject({ cancelledCount: 6, bookedCount: 6, keptCount: 0 });
    const next = await visitsOf(place, changed.newSeriesId);
    expect(next.map((visit) => localDateOf(visit.starts_at.getTime(), "Asia/Kolkata"))).toEqual(original.map((visit) => localDateOf(visit.starts_at.getTime(), "Asia/Kolkata")));
    expect(next.every((visit) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(visit.starts_at) === "14:00")).toBe(true);
    // Moving the day by one for "all" from visit 3 moves the whole series by one day, not just from visit 3.
    const view2 = await getSeriesView(place.context, changed.newSeriesId);
    const nextThird = next[2]!;
    const wed = new Date(localInstant(addDays(localDateOf(nextThird.starts_at.getTime(), "Asia/Kolkata"), 1), "14:00", "Asia/Kolkata")).toISOString();
    const moved = await changeSeries(place.context, changed.newSeriesId, { action: "change", scope: "all", fromAppointmentId: nextThird.id, expectedVersion: view2.version, startsAt: wed, resolutions: [] }, `all-${randomUUID()}`);
    if (!moved.changed || !moved.newSeriesId) throw new Error("not moved");
    const shifted = await visitsOf(place, moved.newSeriesId);
    expect(shifted.map((visit) => localDateOf(visit.starts_at.getTime(), "Asia/Kolkata"))).toEqual(next.map((visit) => addDays(localDateOf(visit.starts_at.getTime(), "Asia/Kolkata"), 1)));
  });

  it("sends the series confirmation through the real WhatsApp and email adapters: WhatsApp only with consent, email otherwise", async () => {
    const place = await setup("series-channels", "Asia/Kolkata");
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
    const person = async (label: string, consent: boolean) => {
      const [row] = await owner<{ id: string }[]>`
        insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel, messaging_consent_at)
        values (${place.fixture.tenantId}, ${label}, 'Series', ${`+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`}, ${`${label.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`}, 'whatsapp', ${consent ? new Date() : null}) returning id`;
      return row!.id;
    };
    const start = nextWeekday("Asia/Kolkata", 3, 5);
    savedOf(await save(place, start, weekly(3), [], { patientId: await person("Wapp", true) }));
    await drainTenantOutbox(worker, place.fixture.tenantId, handlers);
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]!.content).toMatchObject({ kind: "template", templateKey: "series_confirmed" });
    const variables = (whatsapp.sent[0]!.content as { variables: string[] }).variables;
    expect(variables).toHaveLength(5);
    expect(variables[0]).toBe("Wapp");
    expect(variables[3]).toMatch(/^3 visits, from /);
    expect(variables[4]).toMatch(/^https:\/\/app\.example\.test\/manage\//);
    expect(email.sent).toHaveLength(0);

    // Preferring WhatsApp but never having agreed to messages: it goes by email, listing every date.
    savedOf(await save(place, addDays(start, 28), weekly(3), [], { patientId: await person("Mail", false) }));
    await drainTenantOutbox(worker, place.fixture.tenantId, handlers);
    expect(whatsapp.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.subject).toMatch(/3 .* booked/);
    expect((email.sent[0]?.text.match(/\b20\d\d\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(email.sent[0]?.text).toMatch(/https:\/\/app\.example\.test\/manage\//);
    // The log names the channel and template, never an address, a number or the link.
    const notes = await owner<{ channel: string; destination_ciphertext: string }[]>`
      select channel, destination_ciphertext from notifications where tenant_id = ${place.fixture.tenantId} and template_key = 'series.confirmation'`;
    expect(notes.map((row) => row.channel).sort()).toEqual(["email", "whatsapp"]);
    expect(notes.every((row) => !/@|\+91|manage\//.test(row.destination_ciphertext))).toBe(true);
  });

  it("keeps 10:00 local time across a clock change", async () => {
    // The next time the clocks change in London, found from the zone itself so this test does not go stale.
    let date = localDateOf(Date.now(), "Europe/London");
    const offsetOf = (day: string) => new TZDate(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 12, 0, 0, "Europe/London").getTimezoneOffset();
    let change = "";
    for (let guard = 0; guard < 400 && !change; guard += 1) {
      const next = addDays(date, 1);
      if (offsetOf(next) !== offsetOf(date)) change = next;
      date = next;
    }
    expect(change).not.toBe("");
    let first = addDays(change, -21);
    while (new Date(localInstant(first, "10:00", "Europe/London")).getTime() < Date.now() + 2 * 86_400_000) first = addDays(first, 7);
    const saved = savedOf(await save(london, first, weekly(8)));
    const visits = await visitsOf(london, saved.seriesId);
    expect(visits).toHaveLength(8);
    const local = visits.map((visit) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(visit.starts_at));
    expect(new Set(local)).toEqual(new Set(["10:00"]));
    const utcHours = new Set(visits.map((visit) => visit.starts_at.getUTCHours()));
    expect(utcHours.size).toBe(2); // 10:00 on the wall clock is two different instants-of-day either side of the change
    expect(visits[0]!.starts_at.getTime()).toBe(localInstant(first, "10:00", "Europe/London"));
  });

  it("cancelling 'all' leaves completed and checked-in visits untouched", async () => {
    const kolkata = await setup("series-cancel", "Asia/Kolkata");
    const start = nextWeekday("Asia/Kolkata", 5, 5);
    const saved = savedOf(await save(kolkata, start, weekly(5)));
    const visits = await visitsOf(kolkata, saved.seriesId);
    // Visit 1 finished, visit 2 checked in (as the schedule would record them), visit 3 already cancelled by the customer.
    await owner`update appointments set status = 'completed', completed_at = now(), version = version + 1 where id = ${visits[0]!.id}`;
    await owner`update appointments set status = 'checked_in', checked_in_at = now(), version = version + 1 where id = ${visits[1]!.id}`;
    await updateAppointmentStatus(kolkata.context.userId!, visits[2]!.id, { status: "cancelled", expectedVersion: visits[2]!.version });
    const view = await getSeriesView(kolkata.context, saved.seriesId);
    const before = await visitsOf(kolkata, saved.seriesId);

    const result = await changeSeries(kolkata.context, saved.seriesId, { action: "cancel", scope: "all", fromAppointmentId: visits[0]!.id, expectedVersion: view.version }, `cancel-${randomUUID()}`);
    expect(result).toMatchObject({ changed: true, newSeriesId: null, cancelledCount: 2, keptCount: 3 });
    const after = await visitsOf(kolkata, saved.seriesId);
    expect(after.map((visit) => visit.status)).toEqual(["completed", "checked_in", "cancelled", "cancelled", "cancelled"]);
    expect(after.slice(0, 3).map((visit) => visit.version)).toEqual(before.slice(0, 3).map((visit) => visit.version)); // visits 1 to 3 were not written
    const [series] = await owner<{ status: string }[]>`select status from appointment_series where id = ${saved.seriesId}`;
    expect(series!.status).toBe("ended");
    // Nothing was kept in a second series: cancelling everything open and keeping nothing marks the series cancelled.
    const lone = savedOf(await save(kolkata, nextWeekday("Asia/Kolkata", 6, 5), weekly(3)));
    const loneView = await getSeriesView(kolkata.context, lone.seriesId);
    const loneVisits = await visitsOf(kolkata, lone.seriesId);
    await changeSeries(kolkata.context, lone.seriesId, { action: "cancel", scope: "following", fromAppointmentId: loneVisits[0]!.id, expectedVersion: loneView.version }, `cancel-${randomUUID()}`);
    expect((await owner<{ status: string }[]>`select status from appointment_series where id = ${lone.seriesId}`)[0]!.status).toBe("cancelled");
    await expectApiError(changeSeries(kolkata.context, lone.seriesId, { action: "cancel", scope: "all", fromAppointmentId: loneVisits[0]!.id, expectedVersion: loneView.version + 1 }, `cancel-${randomUUID()}`), "series_not_active");
  });

  it("keeps a visit in its series when one visit is moved or cancelled on its own", async () => {
    const kolkata = await setup("series-single", "Asia/Kolkata");
    const start = nextWeekday("Asia/Kolkata", 1, 6);
    const saved = savedOf(await save(kolkata, start, weekly(4)));
    const visits = await visitsOf(kolkata, saved.seriesId);
    const moveTo = new Date(localInstant(addDays(start, 7), "14:00", "Asia/Kolkata")).toISOString();
    await mutateStaffAppointment(kolkata.context, visits[1]!.id, { action: "reschedule", startsAt: moveTo, practitionerId: kolkata.fixture.practitionerId, expectedVersion: visits[1]!.version });
    await updateAppointmentStatus(kolkata.context.userId!, visits[2]!.id, { status: "cancelled", expectedVersion: visits[2]!.version });
    // The customer's own link: cancelling one visit.
    const token = `manage-${randomUUID()}`;
    await owner`update appointments set manage_token_hash = ${sha256(token)} where id = ${visits[3]!.id}`;
    await manageAppointment(token, { action: "cancel", expectedVersion: visits[3]!.version });
    const after = await owner<{ series_id: string; series_index: number; status: string; starts_at: Date }[]>`
      select series_id, series_index, status, starts_at from appointments where id in (${visits[1]!.id}, ${visits[2]!.id}, ${visits[3]!.id}) order by series_index`;
    expect(after.map((row) => [row.series_id, Number(row.series_index), row.status])).toEqual([
      [saved.seriesId, 2, "booked"], [saved.seriesId, 3, "cancelled"], [saved.seriesId, 4, "cancelled"],
    ]);
    expect(after[0]!.starts_at.toISOString()).toBe(moveTo);
  });

  it("sends one confirmation for the whole series, not one per visit, while reminders and calendar writes stay per visit", async () => {
    const place = await setup("series-messages", "Asia/Kolkata");
    // A "booked" workflow and a reminder: the first must not fire for a series, the second must plan for every visit.
    const [booked] = await owner<{ id: string }[]>`insert into workflows (tenant_id, name, trigger) values (${place.fixture.tenantId}, 'Booked', 'booked') returning id`;
    await owner`insert into workflow_steps (tenant_id, workflow_id, position, channel, body) values (${place.fixture.tenantId}, ${booked!.id}, 1, 'email', 'You are booked')`;
    const [reminder] = await owner<{ id: string }[]>`insert into workflows (tenant_id, name, trigger, offset_minutes) values (${place.fixture.tenantId}, 'Reminder', 'before_start', 60) returning id`;
    await owner`insert into workflow_steps (tenant_id, workflow_id, position, channel, body) values (${place.fixture.tenantId}, ${reminder!.id}, 1, 'email', 'See you soon')`;
    await owner`insert into workflow_settings (tenant_id, quiet_start_minute, quiet_end_minute) values (${place.fixture.tenantId}, 0, 0) on conflict (tenant_id) do update set quiet_start_minute = 0, quiet_end_minute = 0`;

    sent.length = 0;
    const saved = savedOf(await save(place, nextWeekday("Asia/Kolkata", 2, 6), weekly(8)));
    // A single booking made the same way still fires "booked", so the suppression is the series' doing.
    const single = await createStaffAppointment(place.context, bookingFor(place, nextWeekday("Asia/Kolkata", 4, 6), "15:00"), `single-${randomUUID()}`, randomUUID());
    const planned = await owner<{ appointment_id: string; slot_key: string; trigger: string }[]>`
      select message.appointment_id, message.slot_key, workflow.trigger from scheduled_messages as message
      join workflows as workflow on workflow.tenant_id = message.tenant_id and workflow.id = message.workflow_id
      where message.tenant_id = ${place.fixture.tenantId}`;
    const ids = (await visitsOf(place, saved.seriesId)).map((visit) => visit.id);
    expect(planned.filter((row) => ids.includes(row.appointment_id) && row.trigger === "booked")).toHaveLength(0);
    expect(planned.filter((row) => row.appointment_id === single.appointmentId && row.trigger === "booked")).toHaveLength(1);
    expect(new Set(planned.filter((row) => row.trigger === "before_start" && ids.includes(row.appointment_id)).map((row) => row.appointment_id)).size).toBe(8);
    const statuses = await owner<{ reminder_status: string }[]>`select reminder_status from appointments where series_id = ${saved.seriesId}`;
    expect(statuses.every((row) => row.reminder_status === "queued")).toBe(true);

    await drain(place);
    const forSeries = sent.filter((message) => message.tenantId === place.fixture.tenantId && message.message.templateKey === "series.confirmation");
    expect(forSeries).toHaveLength(1);
    const body = JSON.parse(forSeries[0]!.message.body) as { dates: string[]; count: number; kind: string; url: string };
    expect(body).toMatchObject({ kind: "booked", count: 8 });
    expect(body.dates).toHaveLength(8);
    expect(body.url).toContain("https://app.example.test/manage/");
    // No per-visit "booked" message for any series visit; the one single booking still gets its own.
    const perVisit = sent.filter((message) => message.tenantId === place.fixture.tenantId && message.appointmentId && ids.includes(message.appointmentId) && message.message.templateKey !== "series.confirmation");
    expect(perVisit).toEqual([]);
    expect(sent.filter((message) => message.appointmentId === single.appointmentId)).toHaveLength(1);
  });

  it("sends the cancel-all message once, and not one per cancelled visit", async () => {
    const place = await setup("series-cancel-message", "Asia/Kolkata");
    const saved = savedOf(await save(place, nextWeekday("Asia/Kolkata", 3, 6), weekly(4)));
    await drain(place);
    sent.length = 0;
    const view = await getSeriesView(place.context, saved.seriesId);
    const visits = await visitsOf(place, saved.seriesId);
    await changeSeries(place.context, saved.seriesId, { action: "cancel", scope: "all", fromAppointmentId: visits[0]!.id, expectedVersion: view.version }, `cancel-${randomUUID()}`);
    await drain(place);
    const mine = sent.filter((message) => message.tenantId === place.fixture.tenantId);
    expect(mine.map((message) => message.message.templateKey)).toEqual(["series.confirmation"]);
    expect(JSON.parse(mine[0]!.message.body)).toMatchObject({ kind: "cancelled", count: 4, url: "" });
  });

  it("gives one winner when two people save the same series at the same moment, and replays a double click", async () => {
    const place = await setup("series-race", "Asia/Kolkata");
    const start = nextWeekday("Asia/Kolkata", 2, 4);
    const key = `race-${randomUUID()}`;
    const [a, b] = await Promise.all([
      saveSeries(place.context, { booking: bookingFor(place, start, "10:00"), rule: weekly(6), resolutions: [] }, key),
      saveSeries(place.context, { booking: bookingFor(place, start, "10:00"), rule: weekly(6), resolutions: [] }, key),
    ]);
    expect(a).toEqual(b); // the same key is one request
    expect(a.saved).toBe(true);
    expect((await counts(place)).appointments).toBe(6);

    const [c, d] = await Promise.all([
      saveSeries(place.context, { booking: bookingFor(place, addDays(start, 70), "10:00"), rule: weekly(6), resolutions: [] }, `race-${randomUUID()}`),
      saveSeries(place.context, { booking: bookingFor(place, addDays(start, 70), "10:00"), rule: weekly(6), resolutions: [] }, `race-${randomUUID()}`),
    ]);
    expect([c.saved, d.saved].sort()).toEqual([false, true]);
    expect((await counts(place)).appointments).toBe(12);
    expect((await counts(place)).series).toBe(2);
  });

  it("keeps every business's series to itself", async () => {
    const saved = savedOf(await save(kolkata, nextWeekday("Asia/Kolkata", 7, 4), weekly(3)));
    await expectApiError(getSeriesView(other.context, saved.seriesId), "series_not_found");
    await expect(changeSeries(other.context, saved.seriesId, { action: "cancel", scope: "all", fromAppointmentId: (await visitsOf(kolkata, saved.seriesId))[0]!.id, expectedVersion: 1 }, `x-${randomUUID()}`)).rejects.toThrow();
    // As the web app's own role, scoped to the other business, the rows are invisible and cannot be written.
    const seen = await runtime.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${other.fixture.tenantId}, true)`;
      return transaction`select id from appointment_series where id = ${saved.seriesId}`;
    });
    expect(seen).toHaveLength(0);
    await expect(runtime.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${other.fixture.tenantId}, true)`;
      await transaction`insert into appointment_series (tenant_id, patient_id, service_id, practitioner_id, location_id, rule_text, rule, starts_on, time_of_day, duration_minutes, occurrence_count)
        values (${kolkata.fixture.tenantId}, ${kolkata.patientId}, ${kolkata.fixture.serviceId}, ${kolkata.fixture.practitionerId}, ${kolkata.fixture.locationId}, 'RRULE:FREQ=DAILY', '{}', '2030-01-01', '10:00', 60, 1)`;
    })).rejects.toThrow();
    // A visit in one business cannot point at another business's series: the composite key refuses it when the transaction commits.
    await expect(owner.begin(async (transaction) => {
      await transaction`insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, series_id, series_index)
        values (${other.fixture.tenantId}, ${other.fixture.locationId}, ${other.patientId}, ${other.fixture.practitionerId}, ${other.fixture.serviceId}, now() + interval '30 days', now() + interval '30 days 1 hour', 'booked', 'staff', ${randomUUID() + randomUUID()}, ${saved.seriesId}, 1)`;
    })).rejects.toThrow();
    const [unscoped] = await runtime<{ count: number }[]>`select count(*)::int as count from appointment_series`;
    expect(unscoped!.count).toBe(0);
  });

  it("refuses what it should: a walk-in, a person without the permission, another business, a rule that makes nothing, a preview", async () => {
    const start = nextWeekday("Asia/Kolkata", 2, 4);
    await expectApiError(save(kolkata, start, weekly(3), [], { source: "walk_in" }), "validation_error");
    const nurse = { ...kolkata.context, role: "practitioner" as const, permissions: resolvePermissions("practitioner", {}) };
    await expectApiError(saveSeries(nurse, { booking: bookingFor(kolkata, start, "10:00"), rule: weekly(3), resolutions: [] }, `k-${randomUUID()}`), "forbidden");
    await expectApiError(previewSeries(nurse, bookingFor(kolkata, start, "10:00"), weekly(3)), "forbidden");
    await expectApiError(saveSeries(other.context, { booking: bookingFor(kolkata, start, "10:00"), rule: weekly(3), resolutions: [] }, `k-${randomUUID()}`), "forbidden");
    await expectApiError(previewSeries(kolkata.context, bookingFor(kolkata, start, "10:00"), weekly(3, { end: { kind: "until", date: addDays(start, -3) } })), "validation_error");
    await expectApiError(previewSeries({ ...kolkata.context, preview: true }, bookingFor(kolkata, start, "10:00"), weekly(3)), "unavailable_in_preview");
  });

  it("caps a series at 12 months and 52 visits", async () => {
    const start = nextWeekday("Asia/Kolkata", 2, 4);
    const preview: SeriesPreview = await previewSeries(kolkata.context, bookingFor(kolkata, start, "10:00"), weekly(52));
    expect(preview.visits.length).toBeLessThanOrEqual(52);
    expect(preview.visits.length).toBe(52);
    const long = await previewSeries(kolkata.context, bookingFor(kolkata, start, "10:00"), { frequency: "monthly_date", interval: 1, weekdays: [], end: { kind: "until", date: addDays(start, 900) } });
    expect(long.visits.length).toBeLessThanOrEqual(12);
    expect(long.capped).toBe(true);
  });
});
