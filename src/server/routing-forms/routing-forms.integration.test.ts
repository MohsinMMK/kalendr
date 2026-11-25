/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";
import { resolveEntitlements } from "@/lib/entitlements";
import type { RoutingDraft } from "@/lib/routing-forms";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createBooking, createCustomer, createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { GET as availabilityRoute } from "@/app/api/public/availability/route";
import { POST as bookingRoute } from "@/app/api/public/appointments/route";
import { POST as holdRoute } from "@/app/api/public/holds/route";
import { POST as submitRoute } from "@/app/api/public/routing/[clinicSlug]/[formSlug]/route";
import { POST as openRoute } from "@/app/api/public/routing/[clinicSlug]/[formSlug]/open/route";
import { createAppointment } from "@/server/appointment-repository";
import { loadAudience } from "@/server/campaigns/audience";
import { postgresRunner } from "@/server/workflows/runner";
import { loadTimeline } from "@/server/customers/timeline";
import { addDays, isoWeekday, localDateOf, localInstant } from "@/server/slot-engine/time";
import type { StaffContext } from "@/server/staff-context";

import { checkDefinition, createRoutingForm, deleteRoutingForm, getRoutingForm, pauseRoutingForm, previewRoutingForm, publishRoutingForm, updateRoutingForm } from "./forms";
import { getPublicRoutingForm, openRoutingForm, submitRoutingAnswers } from "./public";
import { routingCsv, routingReport } from "./report";
import { getAppointmentRouting, getRoutingPrefill } from "./trace";
import { listWrongAssignments, reportWrongAssignment, reviewWrongAssignment } from "./wrong-assignment";
import { withTenant } from "@/db/client";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl) ? describe : describe.skip;

const ZONE = "Asia/Kolkata";

function dayAhead(minDays: number): string {
  let date = localDateOf(Date.now(), ZONE);
  for (let guard = 0; guard < 60; guard += 1) {
    date = addDays(date, 1);
    if (new Date(localInstant(date, "00:00", ZONE)).getTime() > Date.now() + minDays * 86_400_000 && isoWeekday(date) <= 5) return date;
  }
  throw new Error("no date");
}

interface Clinic {
  fixture: TenantFixture;
  context: StaffContext;
  doctors: { iyer: string; shah: string; rao: string };
  languageId: string;
  seniorityId: string;
}

const tokenOf = (url: string): string => new URL(url, "https://x.test").searchParams.get("routing") ?? "";

describeIsolated("routing forms (feature 46)", () => {
  let owner: postgres.Sql;
  let clinic: Clinic;
  let other: Clinic;

  async function makeClinic(label: string): Promise<Clinic> {
    const fixture = await createTenant(owner, label, "healthcare");
    await owner`update services set name = 'Consultation', duration_minutes = 60, slot_interval_minutes = 60, minimum_lead_minutes = 0, maximum_advance_days = 90, assignment = 'any_available' where id = ${fixture.serviceId}`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${fixture.locationId})`;
    const ids: string[] = [fixture.practitionerId];
    await owner`update practitioners set name = 'Dr Iyer' where id = ${fixture.practitionerId}`;
    for (const name of ["Dr Shah", "Dr Rao"]) {
      const [row] = await owner<{ id: string }[]>`insert into practitioners (tenant_id, name, title, initials, specialty) values (${fixture.tenantId}, ${name}, 'Doctor', 'D', 'GP') returning id`;
      ids.push(row!.id);
    }
    for (const id of ids) {
      await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${id}, ${fixture.locationId})`;
      await owner`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${fixture.tenantId}, ${id}, ${fixture.serviceId})`;
      for (let day = 1; day <= 7; day += 1) {
        await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
          values (${randomUUID()}, ${fixture.tenantId}, ${fixture.locationId}, ${id}, ${day}, '09:00', '17:00', ${ZONE}, '2025-01-01', 60)`;
      }
    }
    const [language] = await owner<{ id: string }[]>`insert into attribute_definitions (tenant_id, name, kind, options) values (${fixture.tenantId}, 'Language', 'multiple', ${["Tamil", "Hindi", "English"]}) returning id`;
    const [seniority] = await owner<{ id: string }[]>`insert into attribute_definitions (tenant_id, name, kind, options) values (${fixture.tenantId}, 'Seniority', 'single', ${["Senior", "Junior"]}) returning id`;
    const set = (practitionerId: string, attributeId: string, value: unknown) =>
      owner`insert into practitioner_attributes (tenant_id, practitioner_id, attribute_id, value) values (${fixture.tenantId}, ${practitionerId}, ${attributeId}, ${JSON.stringify(value)}::jsonb)`;
    await set(ids[0]!, language!.id, ["Tamil", "English"]);
    await set(ids[1]!, language!.id, ["Hindi"]);
    await set(ids[0]!, seniority!.id, "Senior");
    const [user] = await owner<{ id: string }[]>`insert into auth_users (name, email, email_verified) values (${`Staff ${label}`}, ${`staff-${randomUUID().slice(0, 8)}@example.com`}, true) returning id`;
    await owner`insert into memberships (tenant_id, user_id, role) values (${fixture.tenantId}, ${user!.id}, 'owner')`;
    return { fixture, context: staffContext(fixture, { userId: user!.id }), doctors: { iyer: ids[0]!, shah: ids[1]!, rao: ids[2]! }, languageId: language!.id, seniorityId: seniority!.id };
  }

  const draftFor = (place: Clinic, slug = "first-visit"): RoutingDraft => ({
    name: "Which visit do you need?",
    slug,
    intro: "Two quick questions.",
    definition: {
      questions: [
        { id: "first", type: "yes_no", label: "First visit?", required: true },
        { id: "language", type: "single_choice", label: "Language?", required: true, options: ["Tamil", "Hindi", "English"], prefillKey: "language" },
        { id: "email", type: "email", label: "Email", required: false },
      ],
      routes: [{
        id: "tamil-first", name: "First-time Tamil speaker",
        conditions: [{ fieldId: "first", operator: "equals", value: "yes" }, { fieldId: "language", operator: "equals", value: "Tamil" }],
        destination: { type: "service", serviceId: place.fixture.serviceId, people: { personIds: [], filters: [{ attributeId: place.languageId, operator: "includes", source: { type: "question", fieldId: "language" } }], weights: [{ attributeId: place.seniorityId, value: "Senior", multiplier: 2 }] } },
      }, {
        id: "follow-up", name: "Follow-up", conditions: [{ fieldId: "first", operator: "equals", value: "no" }],
        destination: { type: "external", url: "https://example.com/follow-up" },
      }],
      fallback: { type: "message", title: "Call us", body: "We will help you book." },
    },
  });

  const at = (date: string, time: string) => new Date(localInstant(date, time, ZONE)).toISOString();
  const endOf = (iso: string) => new Date(Date.parse(iso) + 3_600_000).toISOString();
  const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ctx = (place: Clinic, slug = "first-visit") => ({ params: Promise.resolve({ clinicSlug: place.fixture.slug, formSlug: slug }) });

  async function liveForm(place: Clinic, slug = "first-visit") {
    const created = await createRoutingForm(place.context, draftFor(place, slug));
    return publishRoutingForm(place.context, created.form.id, created.form.revision);
  }

  async function answer(place: Clinic, answers: Record<string, unknown>, slug = "first-visit") {
    const opened = await (await openRoute(new Request("https://x.test/open", json({})), { params: Promise.resolve({ clinicSlug: place.fixture.slug, formSlug: slug }) })).json() as { data: { token: string } };
    const response = await submitRoute(new Request("https://x.test/submit", json({ answers, responseToken: opened.data.token })), ctx(place, slug));
    return { status: response.status, body: await response.json() as { data?: { type: string; url?: string }; error?: { code: string } }, token: opened.data.token };
  }

  const bookingFor = (place: Clinic, startsAt: string, over: Partial<PublicBookingInput> = {}): PublicBookingInput => ({
    clinicSlug: place.fixture.slug, patientType: "new", bookingFor: "self", locationId: place.fixture.locationId, serviceId: place.fixture.serviceId,
    practitionerId: "anyone", slotId: `slot_${randomUUID().replaceAll("-", "")}`, startsAt, endsAt: endOf(startsAt),
    firstName: "Route", lastName: `Customer${randomUUID().slice(0, 6)}`, phone: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    email: `route-${randomUUID().slice(0, 8)}@example.com`, preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false, ...over,
  });

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 4, prepare: false });
    clinic = await makeClinic("rf-a");
    other = await makeClinic("rf-b");
  });
  afterAll(async () => {
    await owner?.end();
  });

  it("sends a first-time Tamil speaker to a consultation with the Tamil-speaking doctor, with answers prefilled, and shows the trace on the booking", async () => {
    await liveForm(clinic);
    const date = dayAhead(3);
    // Dr Shah and Dr Rao are free at 10:00; Dr Iyer (the only Tamil speaker) is busy then.
    await createAppointment(bookingFor(clinic, at(date, "10:00"), { practitionerId: clinic.doctors.iyer }), randomUUID(), randomUUID().replaceAll("-", ""));

    const result = await answer(clinic, { first: true, language: "Tamil", email: "tamil.speaker@example.com" });
    expect(result.status).toBe(200);
    expect(result.body, JSON.stringify(result.body)).toMatchObject({ data: { type: "booking" } });
    const url = result.body.data!.url!;
    expect(url).toContain(`service=${clinic.fixture.serviceId}`);
    // The booking address carries a token, never an answer.
    expect(url).not.toContain("Tamil");
    expect(url).not.toContain("tamil.speaker");
    const token = tokenOf(url);
    expect(token.length).toBeGreaterThanOrEqual(40);

    const prefill = await getRoutingPrefill(clinic.fixture.tenantId, token);
    expect(prefill).toMatchObject({ serviceId: clinic.fixture.serviceId, prefill: { language: "Tamil", email: "tamil.speaker@example.com" }, candidateIds: [clinic.doctors.iyer] });

    // Only the Tamil-speaking doctor's times are listed, and they are listed as one pool.
    const query = new URLSearchParams({ clinicSlug: clinic.fixture.slug, locationId: clinic.fixture.locationId, serviceId: clinic.fixture.serviceId, practitionerId: "anyone", from: at(date, "00:00"), to: at(addDays(date, 1), "00:00"), routingToken: token });
    const listing = await (await availabilityRoute(new Request(`https://x.test/a?${query}`))).json() as { data: { slots: Array<{ startsAt: string }>; nextByPerson?: Record<string, string> } };
    expect(Object.keys(listing.data.nextByPerson ?? {})).toEqual([clinic.doctors.iyer]);
    expect(listing.data.slots.map((slot) => slot.startsAt)).not.toContain(new Date(at(date, "10:00")).toISOString());
    expect(listing.data.slots.length).toBeGreaterThan(0);

    // A hold for someone the form did not pick is refused.
    const wrongHold = await holdRoute(new Request("https://x.test/h", json({ clinicSlug: clinic.fixture.slug, locationId: clinic.fixture.locationId, serviceId: clinic.fixture.serviceId, practitionerId: clinic.doctors.shah, startsAt: at(date, "12:00"), endsAt: endOf(at(date, "12:00")), routingToken: token })));
    expect(wrongHold.status).toBe(409);

    // Booking as "anyone" gives the Tamil speaker, and links the response.
    const booking = await bookingRoute(new Request("https://x.test/b", json(bookingFor(clinic, at(date, "12:00"), { email: "tamil.speaker@example.com", routingToken: token } as Partial<PublicBookingInput>), { "Idempotency-Key": randomUUID() })));
    expect(booking.status).toBe(201);
    const created = await booking.json() as { data: { appointmentId: string } };
    const [row] = await owner<{ practitioner_id: string }[]>`select practitioner_id from appointments where id = ${created.data.appointmentId}`;
    expect(row?.practitioner_id).toBe(clinic.doctors.iyer);

    const trace = await getAppointmentRouting(clinic.context, created.data.appointmentId);
    expect(trace?.summary).toMatch(/^Routed by: First visit\? = yes, Language\? = Tamil\. Dr Iyer was the only person free/);
    expect(trace?.trace.people.find((person) => person.personId === clinic.doctors.shah)?.passed).toBe(false);
    // The trace never holds what the customer typed.
    expect(JSON.stringify(trace)).not.toContain("tamil.speaker@example.com");
    const [response] = await owner<{ outcome: string; patient_id: string | null }[]>`select outcome, patient_id from routing_responses where appointment_id = ${created.data.appointmentId}`;
    expect(response).toMatchObject({ outcome: "booked" });
    expect(response?.patient_id).toBeTruthy();

    // The answer reaches the customer's profile (wave 4C) as a line on their timeline, without any answer in it.
    const page = await loadTimeline(clinic.context, response!.patient_id!, { kinds: ["form"] });
    const entry = page.entries.find((item) => item.title.startsWith("Answered Which visit"));
    expect(entry).toMatchObject({ kind: "form", detail: "First-time Tamil speaker", status: "booked" });
    expect(JSON.stringify(page)).not.toContain("tamil.speaker@example.com");
  });

  it("refuses a routing token for another service, an unknown token and a booking by a person the form did not pick", async () => {
    const date = dayAhead(4);
    const { token } = await answer(clinic, { first: true, language: "Tamil" });
    const query = (extra: Record<string, string>) => new URLSearchParams({ clinicSlug: clinic.fixture.slug, locationId: clinic.fixture.locationId, serviceId: clinic.fixture.serviceId, practitionerId: "anyone", from: at(date, "00:00"), to: at(addDays(date, 1), "00:00"), ...extra });
    expect((await availabilityRoute(new Request(`https://x.test/a?${query({ routingToken: "x".repeat(43) })}`))).status).toBe(400);
    const specific = await bookingRoute(new Request("https://x.test/b", json({ ...bookingFor(clinic, at(date, "13:00"), { practitionerId: clinic.doctors.shah }), routingToken: token }, { "Idempotency-Key": randomUUID() })));
    expect(specific.status).toBe(409);
    expect(await getRoutingPrefill(clinic.fixture.tenantId, "not-a-real-token-not-a-real-token")).toBeNull();
  });

  it("gives the same answer for an unknown form, a draft form, a paused form and another business's form", async () => {
    const created = await createRoutingForm(clinic.context, draftFor(clinic, "still-draft"));
    const read = async (place: Clinic, slug: string) => {
      try {
        await getPublicRoutingForm(place.fixture.slug, slug);
        return "ok";
      } catch (error) {
        return `${(error as { status: number }).status}:${(error as { code: string }).code}:${(error as Error).message}`;
      }
    };
    const unknown = await read(clinic, "does-not-exist");
    expect(unknown.startsWith("404:routing_form_not_found")).toBe(true);
    expect(await read(clinic, "still-draft")).toBe(unknown);
    expect(await read(other, "first-visit")).toBe(unknown);
    const live = await publishRoutingForm(clinic.context, created.form.id, created.form.revision);
    expect(await read(clinic, "still-draft")).toBe("ok");
    await pauseRoutingForm(clinic.context, created.form.id, live.form.revision);
    expect(await read(clinic, "still-draft")).toBe(unknown);
    const business = await getPublicRoutingForm(clinic.fixture.slug, "first-visit");
    expect(business.questions.map((question) => question.id)).toEqual(["first", "language", "email"]);
    await expect(openRoutingForm(clinic.fixture.slug, "still-draft")).rejects.toMatchObject({ status: 404 });
    await expect(submitRoutingAnswers(clinic.fixture.slug, "still-draft", { answers: {} })).rejects.toMatchObject({ status: 404 });
  });

  it("validates answers on the server and sends other routes and the fallback", async () => {
    const bad = await answer(clinic, { first: true, language: "Klingon" });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe("validation_error");
    expect((await answer(clinic, { first: false, language: "Hindi" })).body.data).toMatchObject({ type: "external", url: "https://example.com/follow-up" });
    expect((await answer(clinic, { first: true, language: "English" })).body.data).toMatchObject({ type: "message", title: "Call us" });
    const unexpected = await submitRoute(new Request("https://x.test/s", json({ answers: {}, extra: 1 })), ctx(clinic));
    expect(unexpected.status).toBe(400);
  });

  it("warns in the builder about a route that can never be reached and about a hidden or inactive destination", async () => {
    const draft = draftFor(clinic, "warn");
    draft.definition.routes.unshift({ id: "everyone", name: "Everyone", conditions: [], destination: { type: "message", title: "Hi", body: "Hello" } });
    const created = await createRoutingForm(clinic.context, draft);
    const shadowed = created.warnings.filter((warning) => warning.kind === "shadowed").map((warning) => warning.routeId);
    expect(shadowed).toEqual(expect.arrayContaining(["tamil-first", "follow-up"]));
    await owner`update services set visibility = 'hidden' where id = ${clinic.fixture.serviceId}`;
    const hidden = await getRoutingForm(clinic.context, created.form.id);
    expect(hidden.warnings.some((warning) => warning.kind === "service_unavailable" && warning.message.includes("hidden"))).toBe(true);
    await owner`update services set visibility = 'listed', is_active = false where id = ${clinic.fixture.serviceId}`;
    const inactive = await getRoutingForm(clinic.context, created.form.id);
    expect(inactive.warnings.some((warning) => warning.message.includes("turned off"))).toBe(true);
    await owner`update services set is_active = true where id = ${clinic.fixture.serviceId}`;
    await withTenant(clinic.fixture.tenantId, async (transaction) => {
      const clean = await checkDefinition(transaction, clinic.fixture.tenantId, draftFor(clinic).definition);
      expect(clean).toEqual([]);
    });
  });

  it("previews without writing anything", async () => {
    const created = await createRoutingForm(clinic.context, draftFor(clinic, "preview-form"));
    const counts = async () => (await owner<{ n: string }[]>`
      select (select count(*) from routing_responses where tenant_id = ${clinic.fixture.tenantId})
           + (select count(*) from routing_forms where tenant_id = ${clinic.fixture.tenantId})
           + (select count(*) from routing_form_versions where tenant_id = ${clinic.fixture.tenantId})
           + (select count(*) from audit_events where tenant_id = ${clinic.fixture.tenantId})
           + (select count(*) from outbox_events where tenant_id = ${clinic.fixture.tenantId})
           + (select count(*) from slot_holds where tenant_id = ${clinic.fixture.tenantId}) as n`)[0]!.n;
    const before = await counts();
    const result = await previewRoutingForm(clinic.context, created.form.id, { first: true, language: "Tamil", email: "p@example.com" });
    expect(result.routeId).toBe("tamil-first");
    expect(result.offered).toEqual([{ personId: clinic.doctors.iyer, name: "Dr Iyer", multiplier: 2 }]);
    expect((await previewRoutingForm(clinic.context, created.form.id, { first: false, language: "Hindi" })).destination.type).toBe("external");
    await expect(previewRoutingForm(clinic.context, created.form.id, { first: true, language: "Klingon" })).rejects.toMatchObject({ status: 400 });
    expect(await counts()).toBe(before);
  });

  it("creates a new version when a live form changes, and responses keep the version they were answered with", async () => {
    const created = await createRoutingForm(clinic.context, draftFor(clinic, "versioned"));
    const first = await publishRoutingForm(clinic.context, created.form.id, created.form.revision);
    expect(first.form.version).toBe(1);
    const old = await answer(clinic, { first: true, language: "Tamil" }, "versioned");
    const draft = draftFor(clinic, "versioned");
    draft.definition.fallback = { type: "message", title: "Changed", body: "A new fallback." };
    const edited = await updateRoutingForm(clinic.context, created.form.id, draft, first.form.revision);
    expect(edited.form.hasUnpublishedChanges).toBe(true);
    // Saving alone changes nothing customers see.
    expect((await answer(clinic, { first: true, language: "English" }, "versioned")).body.data).toMatchObject({ title: "Call us" });
    const second = await publishRoutingForm(clinic.context, created.form.id, edited.form.revision);
    expect(second.form.version).toBe(2);
    expect((await answer(clinic, { first: true, language: "English" }, "versioned")).body.data).toMatchObject({ title: "Changed" });
    const versions = await owner<{ form_version: number }[]>`select form_version from routing_responses where tenant_id = ${clinic.fixture.tenantId} and token_hash is not null order by opened_at`;
    expect(new Set(versions.map((row) => row.form_version))).toEqual(new Set([1, 2]));
    expect(old.status).toBe(200);
    // Publishing the unchanged form again does not make a version.
    const again = await publishRoutingForm(clinic.context, created.form.id, second.form.revision);
    expect(again.form.version).toBe(2);
    // Two people saving at once: the second is told.
    await expect(updateRoutingForm(clinic.context, created.form.id, draft, first.form.revision)).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    await expect(updateRoutingForm(clinic.context, created.form.id, { ...draft, slug: "renamed" }, again.form.revision)).rejects.toMatchObject({ code: "slug_locked" });
  });

  it("reports the funnel, the routes and who answered but did not book last week, and exports without free text", async () => {
    const place = await makeClinic("rf-report");
    const form = await liveForm(place);
    const now = new Date();
    const day = 86_400_000;
    const insert = async (answeredAgoDays: number | null, booked: boolean, destination = "service", route = "tamil-first") => {
      const [row] = await owner<{ id: string }[]>`
        insert into routing_responses (tenant_id, form_id, form_version, token_hash, route_id, route_name, destination_type, service_id, outcome, opened_at, answered_at, slot_shown_at, booked_at, expires_at, answers_ciphertext)
        values (${place.fixture.tenantId}, ${form.form.id}, 1, ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, ${answeredAgoDays === null ? null : route}, ${answeredAgoDays === null ? null : "First-time Tamil speaker"}, ${answeredAgoDays === null ? null : destination},
          ${answeredAgoDays === null ? null : place.fixture.serviceId}, ${booked ? "pending" : "pending"},
          ${new Date(now.getTime() - ((answeredAgoDays ?? 1) * day + 60_000)).toISOString()}::timestamptz,
          ${answeredAgoDays === null ? null : new Date(now.getTime() - answeredAgoDays * day).toISOString()}::timestamptz,
          ${answeredAgoDays !== null && answeredAgoDays < 20 ? new Date(now.getTime() - answeredAgoDays * day).toISOString() : null}::timestamptz,
          null, ${new Date(now.getTime() + day).toISOString()}::timestamptz, ${"sealed-private-answer-should-never-export"}) returning id`;
      return row!.id;
    };
    await insert(null, false);                 // opened only
    await insert(2, false);                    // answered 2 days ago, never booked
    await insert(3, false);                    // answered 3 days ago, never booked
    await insert(12, false);                   // answered 12 days ago: before last week
    const booked = await insert(1, true);
    const [appointment] = await owner<{ id: string }[]>`select id from appointments where tenant_id = ${place.fixture.tenantId} limit 1`;
    if (appointment) await owner`update routing_responses set appointment_id = ${appointment.id}, outcome = 'booked', booked_at = now() where id = ${booked}`;
    else await owner`delete from routing_responses where id = ${booked}`;

    const report = await routingReport(place.context, form.form.id, {}, now);
    expect(report.opened).toBe(appointment ? 5 : 4);
    expect(report.answered).toBe(appointment ? 4 : 3);
    expect(report.answeredNotBookedLastWeek).toBe(2);
    expect(report.answeredNotBooked).toBe(3);
    expect(report.perRoute[0]?.routeId).toBe("tamil-first");
    const csv = await routingCsv(place.context, form.form.id, {}, now);
    expect(csv.split("\n")[0]).toBe("response,form,version,route,goes_to,outcome,opened,answered,times_shown,booked");
    expect(csv).not.toContain("sealed-private-answer");
    expect(csv.trim().split("\n").length).toBeGreaterThan(4);
  });

  it("keeps one business's forms, responses and reports away from another", async () => {
    const form = await liveForm(other, "other-form");
    await expect(getRoutingForm(clinic.context, form.form.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteRoutingForm(clinic.context, form.form.id)).rejects.toMatchObject({ status: 404 });
    await expect(previewRoutingForm(clinic.context, form.form.id, { first: true, language: "Tamil" })).rejects.toMatchObject({ status: 404 });
    expect((await routingReport(clinic.context, form.form.id, {})).opened).toBe(0);
    // The runtime role cannot see another tenant's rows at all.
    await withTenant(clinic.fixture.tenantId, async (transaction) => {
      const rows = await transaction.execute<{ n: string }>(`select count(*)::text as n from routing_forms where tenant_id = '${other.fixture.tenantId}'` as never);
      expect(rows[0]?.n).toBe("0");
    });
  });

  it("takes wrong-assignment reports, keeps the note sealed and out of the audit trail, and lets an admin review them", async () => {
    const date = dayAhead(5);
    const { token } = await answer(clinic, { first: true, language: "Tamil" });
    const booking = await createAppointment({ ...bookingFor(clinic, at(date, "14:00")), practitionerId: "anyone" }, randomUUID(), randomUUID().replaceAll("-", ""), { routingToken: token });
    const unrouted = await createAppointment(bookingFor(clinic, at(date, "15:00")), randomUUID(), randomUUID().replaceAll("-", ""));
    await expect(reportWrongAssignment(clinic.context, { appointmentId: unrouted.appointmentId })).rejects.toMatchObject({ code: "not_routed" });
    const note = "Customer actually needed Dr Shah because of private reasons";
    const report = await reportWrongAssignment(clinic.context, { appointmentId: booking.appointmentId, correctPractitionerId: clinic.doctors.shah, note });
    // Flagging twice does not make a second row.
    expect((await reportWrongAssignment(clinic.context, { appointmentId: booking.appointmentId, note })).id).toBe(report.id);
    const [sealed] = await owner<{ note_ciphertext: string }[]>`select note_ciphertext from wrong_assignment_reports where id = ${report.id}`;
    expect(sealed?.note_ciphertext).not.toContain("private reasons");
    const audits = await owner<{ metadata: unknown }[]>`select metadata from audit_events where tenant_id = ${clinic.fixture.tenantId} and action like 'routing.%'`;
    expect(JSON.stringify(audits)).not.toContain("private reasons");
    const list = await listWrongAssignments(clinic.context);
    expect(list[0]).toMatchObject({ id: report.id, assignedName: "Dr Iyer", correctName: "Dr Shah", note, routeName: "First-time Tamil speaker" });
    await expect(reviewWrongAssignment(clinic.context, report.id, { status: "fixed", expectedVersion: 5 })).rejects.toMatchObject({ code: "version_conflict" });
    await reviewWrongAssignment(clinic.context, report.id, { status: "fixed", expectedVersion: list[0]!.version });
    expect(await listWrongAssignments(clinic.context)).toEqual([]);
    // Free-text answers never reach the audit trail either.
    const typed = await owner<{ n: string }[]>`select count(*)::text as n from audit_events where tenant_id = ${clinic.fixture.tenantId} and metadata::text like '%example.com%'`;
    expect(typed[0]?.n).toBe("0");
  });

  it("follows up with people who answered but did not book, only when they agreed to marketing and have not booked since", async () => {
    const place = await makeClinic("rf-campaign");
    const form = await liveForm(place);
    const consenting = await createCustomer(owner, place.fixture.tenantId, { firstName: "Agreed" });
    const refusing = await createCustomer(owner, place.fixture.tenantId, { firstName: "Refused" });
    const booked = await createCustomer(owner, place.fixture.tenantId, { firstName: "Booked" });
    const early = await createCustomer(owner, place.fixture.tenantId, { firstName: "TooSoon" });
    for (const [customer, granted] of [[consenting, true], [refusing, false], [booked, true], [early, true]] as const) {
      await owner`insert into consent_records (tenant_id, patient_id, purpose, granted, wording_version, source, actor_type) values (${place.fixture.tenantId}, ${customer.id}, 'marketing_messages', ${granted}, '2026-11', 'staff', 'staff')`;
    }
    const respond = (patientId: string, hoursAgo: number) => owner`
      insert into routing_responses (tenant_id, form_id, form_version, token_hash, route_id, route_name, destination_type, service_id, patient_id, opened_at, answered_at, expires_at)
      values (${place.fixture.tenantId}, ${form.form.id}, 1, ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, 'tamil-first', 'First-time Tamil speaker', 'service', ${place.fixture.serviceId}, ${patientId},
        now() - ${hoursAgo} * interval '1 hour', now() - ${hoursAgo} * interval '1 hour', now() + interval '1 day')`;
    await respond(consenting.id, 30);
    await respond(refusing.id, 30);
    await respond(booked.id, 30);
    await respond(early.id, 3);
    await createBooking(owner, place.fixture, booked.id, {});
    const now = new Date();
    const audience = await owner.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${place.fixture.tenantId}, true)`;
      return loadAudience(postgresRunner(transaction), { id: null, kind: "automated", channel: "email", rule: { type: "routing_abandoned", hoursAfter: 24 }, segmentFilter: null, serviceId: null }, { tenantId: place.fixture.tenantId, now, timeZone: ZONE });
    });
    expect(audience.eligible.map((member) => member.patientId)).toEqual([consenting.id]);
    expect(audience.matching).toBe(2);
    expect(audience.leftOut.no_marketing_consent).toBe(1);
  });

  it("needs the plan feature and refuses a form that points at a missing service", async () => {
    const free = { ...clinic.context, entitlements: resolveEntitlements(null) };
    await expect(createRoutingForm(free, draftFor(clinic, "gated"))).rejects.toMatchObject({ status: 402, code: "plan_limit" });
    const draft = draftFor(clinic, "ghost-service");
    draft.definition.fallback = { type: "service", serviceId: "does-not-exist", people: { personIds: [], filters: [], weights: [] } };
    const created = await createRoutingForm(clinic.context, draft);
    await expect(publishRoutingForm(clinic.context, created.form.id, created.form.revision)).rejects.toMatchObject({ code: "service_not_found" });
  });

  it("refuses staff without the permission and a preview business", async () => {
    const receptionist = staffContext(clinic.fixture, { role: "receptionist", permissions: ["routing.report"] });
    await expect(createRoutingForm(receptionist, draftFor(clinic, "nope"))).rejects.toMatchObject({ status: 403 });
    await expect(getRoutingForm({ ...clinic.context, preview: true }, "x")).rejects.toMatchObject({ status: 503 });
  });
});
