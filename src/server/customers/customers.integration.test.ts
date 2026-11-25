/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { SegmentFilter } from "@/lib/segment-filter";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createBooking, createCustomer, createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { ApiError } from "@/server/api-error";
import { assertNotBlocked, blockCustomer, unblockCustomer } from "@/server/customers/block";
import { setFieldValues, createFieldDefinition } from "@/server/customers/fields";
import { mergeCustomers, suggestDuplicates, undoMerge } from "@/server/customers/merge";
import { createNote, deleteNote, listNotes, updateNote } from "@/server/customers/notes";
import { loadCustomerSummary } from "@/server/customers/profile";
import { countSegmentIn, createSegment, listSegmentMembers, listSegments } from "@/server/customers/segments";
import { createTag, listTags, setCustomerTags } from "@/server/customers/tags";
import { loadTimeline } from "@/server/customers/timeline";
import { purgeMergeSnapshots } from "@/worker/customer-jobs";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

async function expectApiError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected ${code}`).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
}

describeIsolated("customer profiles (feature 27)", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let a: TenantFixture;
  let b: TenantFixture;
  const key = () => `test-${randomUUID()}`;

  const consent = (tenantId: string, patientId: string, granted: boolean, at = "now()") =>
    owner.unsafe(`insert into consent_records (tenant_id, patient_id, purpose, granted, wording_version, source, actor_type, created_at)
      values ('${tenantId}', '${patientId}', 'marketing_messages', ${granted}, '2026-11', 'staff', 'staff', ${at})`);

  async function payment(fixture: TenantFixture, input: { appointmentId?: string; patientId?: string; amountMinor: number }) {
    const [row] = await owner<{ id: string }[]>`
      insert into payments (tenant_id, appointment_id, patient_id, location_id, amount_minor, currency, method)
      values (${fixture.tenantId}, ${input.appointmentId ?? null}, ${input.patientId ?? null}, ${input.patientId ? fixture.locationId : null}, ${input.amountMinor}, 'INR', 'cash') returning id`;
    return row!.id;
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 2, prepare: false });
    a = await createTenant(owner, "crm-a");
    b = await createTenant(owner, "crm-b");
  });

  afterAll(async () => {
    await owner.end();
    await worker.end();
  });

  describe("segments", () => {
    it("counts 'no visit in 90 days, more than 3 visits, agreed to marketing' exactly as a hand query does", async () => {
      const tenant = await createTenant(owner, "seg");
      const context = staffContext(tenant);
      const make = async (label: string, options: { visits: number; lastVisitDaysAgo: number; marketing: boolean | null }) => {
        const customer = await createCustomer(owner, tenant.tenantId, { firstName: label });
        // Visits are spread so the most recent one is `lastVisitDaysAgo` days ago.
        for (let index = 0; index < options.visits; index += 1) await createBooking(owner, tenant, customer.id, { endsDaysAgo: options.lastVisitDaysAgo + index * 30 });
        if (options.marketing !== null) await consent(tenant.tenantId, customer.id, options.marketing);
        return customer;
      };
      const match1 = await make("Match1", { visits: 4, lastVisitDaysAgo: 120, marketing: true });
      const match2 = await make("Match2", { visits: 6, lastVisitDaysAgo: 400, marketing: true });
      await make("TooRecent", { visits: 5, lastVisitDaysAgo: 30, marketing: true });
      await make("TooFewVisits", { visits: 3, lastVisitDaysAgo: 200, marketing: true });
      await make("NoConsent", { visits: 5, lastVisitDaysAgo: 200, marketing: null });
      await make("Withdrew", { visits: 5, lastVisitDaysAgo: 200, marketing: true }).then((customer) => consent(tenant.tenantId, customer.id, false));
      const filter: SegmentFilter = { all: [
        { field: "lastVisit", op: "olderThanDays", days: 90 },
        { field: "visits", op: "gt", value: 3 },
        { field: "marketingConsent", value: true },
      ] };
      const counted = await withTenant(tenant.tenantId, (transaction) => countSegmentIn(transaction, tenant.tenantId, filter));
      const [hand] = await owner<{ n: number }[]>`
        select count(*)::int as n from patients p
        where p.tenant_id = ${tenant.tenantId}
          and (select max(starts_at) from appointments where patient_id = p.id and status = 'completed') < now() - interval '90 days'
          and (select count(*) from appointments where patient_id = p.id and status = 'completed') > 3
          and coalesce((select granted from consent_records where patient_id = p.id and purpose = 'marketing_messages' order by created_at desc, id desc limit 1), false)`;
      expect(counted).toBe(2);
      expect(counted).toBe(hand!.n);
      const members = await listSegmentMembers(context, filter, { limit: 10 });
      expect(members.members.map((member) => member.id).sort()).toEqual([match1.id, match2.id].sort());
    });

    it("filters by tag, service, spend, future booking and birthday month, and saves a segment with a live count", async () => {
      const tenant = await createTenant(owner, "seg2");
      const context = staffContext(tenant);
      const vip = await createCustomer(owner, tenant.tenantId, { dateOfBirth: "1990-03-09" });
      const other = await createCustomer(owner, tenant.tenantId, { dateOfBirth: "1990-07-01" });
      const visit = await createBooking(owner, tenant, vip.id);
      await createBooking(owner, tenant, other.id);
      await payment(tenant, { appointmentId: visit, amountMinor: 300_000 });
      const tag = await createTag(context, { name: "VIP", color: "violet" });
      await setCustomerTags(context, vip.id, [tag.id]);
      await owner`insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash)
        values (${tenant.tenantId}, ${tenant.locationId}, ${other.id}, ${tenant.practitionerId}, ${tenant.serviceId}, now() + interval '3 days', now() + interval '3 days 30 minutes', 'booked', 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")})`;
      const count = (filter: SegmentFilter) => withTenant(tenant.tenantId, (transaction) => countSegmentIn(transaction, tenant.tenantId, filter));
      expect(await count({ all: [{ field: "tag", op: "has", tagIds: [tag.id] }] })).toBe(1);
      expect(await count({ all: [{ field: "tag", op: "hasNot", tagIds: [tag.id] }] })).toBe(1);
      expect(await count({ all: [{ field: "service", op: "used", serviceIds: [tenant.serviceId] }] })).toBe(2);
      expect(await count({ all: [{ field: "spend", op: "gte", valueMinor: 250_000 }] })).toBe(1);
      expect(await count({ all: [{ field: "spend", op: "lt", valueMinor: 1 }] })).toBe(1);
      expect(await count({ all: [{ field: "futureBooking", value: true }] })).toBe(1);
      expect(await count({ all: [{ field: "birthdayMonth", month: 3 }] })).toBe(1);
      expect(await count({ all: [] })).toBe(2);
      const saved = await createSegment(context, { name: "Big spenders", filter: { all: [{ field: "spend", op: "gte", valueMinor: 250_000 }] } });
      expect(saved.count).toBe(1);
      expect((await listSegments(context)).map((segment) => segment.name)).toContain("Big spenders");
      await expectApiError(createSegment(context, { name: "big SPENDERS", filter: { all: [] } }), "segment_exists");
    });

    it("never builds SQL from text in the filter: a hostile id is only ever a bound value", async () => {
      const tenant = await createTenant(owner, "seg3");
      await createCustomer(owner, tenant.tenantId);
      const hostile = "x') or 1=1 --";
      const count = await withTenant(tenant.tenantId, (transaction) => countSegmentIn(transaction, tenant.tenantId, { all: [{ field: "tag", op: "has", tagIds: [hostile] }] }));
      expect(count).toBe(0);
    });

    it("keeps one business's customers out of another's segments", async () => {
      const tenant = await createTenant(owner, "seg4");
      await createCustomer(owner, tenant.tenantId);
      await createCustomer(owner, b.tenantId);
      const other = await withTenant(b.tenantId, (transaction) => countSegmentIn(transaction, tenant.tenantId, { all: [] }));
      expect(other).toBe(0);
    });
  });

  describe("timeline", () => {
    it("opens a customer with 500 entries in under a second, newest first, and pages without gaps or repeats", async () => {
      const tenant = await createTenant(owner, "tl");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId);
      await owner.unsafe(`
        insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash)
        select '${tenant.tenantId}', '${tenant.locationId}', '${customer.id}', '${tenant.practitionerId}', '${tenant.serviceId}',
          now() - (n || ' hours')::interval, now() - (n || ' hours')::interval + interval '30 minutes', 'completed', 'staff', md5(random()::text) || md5(random()::text)
        from generate_series(1, 300) as n;
        insert into customer_notes (tenant_id, patient_id, author_name, body, created_at)
        select '${tenant.tenantId}', '${customer.id}', 'Desk', 'note ' || n, now() - (n || ' minutes')::interval from generate_series(1, 200) as n;
      `);
      const started = performance.now();
      const first = await loadTimeline(context, customer.id, { limit: 50 });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1000);
      expect(first.entries).toHaveLength(50);
      expect(first.entries.map((entry) => entry.at)).toEqual([...first.entries.map((entry) => entry.at)].sort().reverse());
      const seen = new Set<string>();
      let page = first;
      for (;;) {
        for (const entry of page.entries) {
          expect(seen.has(entry.key), `repeat ${entry.key}`).toBe(false);
          seen.add(entry.key);
        }
        if (!page.nextCursor) break;
        page = await loadTimeline(context, customer.id, { limit: 50, cursor: page.nextCursor });
      }
      expect(seen.size).toBe(500);
      const onlyNotes = await loadTimeline(context, customer.id, { kinds: ["note"], limit: 100 });
      expect(onlyNotes.entries.every((entry) => entry.kind === "note")).toBe(true);
    });

    it("shows visits, payments, forms, notes and changes in one list and hides payments from people who cannot see money", async () => {
      const tenant = await createTenant(owner, "tl2");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId);
      const visit = await createBooking(owner, tenant, customer.id);
      await payment(tenant, { appointmentId: visit, amountMinor: 50_000 });
      await createNote(context, customer.id, { body: "Prefers mornings", pinned: false }, key());
      await setCustomerTags(context, customer.id, []);
      const page = await loadTimeline(context, customer.id, {});
      const kinds = new Set(page.entries.map((entry) => entry.kind));
      expect(kinds).toContain("visit");
      expect(kinds).toContain("payment");
      expect(kinds).toContain("note");
      const reader = staffContext(tenant, { role: "practitioner", permissions: resolvePermissions("read_only", {}) });
      // A role that sees only its own customers cannot open this one at all; a read-only one sees no money.
      const readOnly = staffContext(tenant, { role: "read_only", permissions: resolvePermissions("read_only", {}) });
      const limited = await loadTimeline(readOnly, customer.id, {});
      expect(limited.entries.some((entry) => entry.kind === "payment")).toBe(false);
      await expectApiError(loadTimeline(reader, customer.id, {}), "customer_not_found");
    });

    it("is closed to another business", async () => {
      const customer = await createCustomer(owner, a.tenantId);
      await expectApiError(loadTimeline(staffContext(b), customer.id, {}), "customer_not_found");
      await expectApiError(loadCustomerSummary(staffContext(b), customer.id), "customer_not_found");
    });
  });

  describe("profile summary", () => {
    it("reports visits, no-shows, lifetime value net of refunds, the average gap and the pinned note", async () => {
      const tenant = await createTenant(owner, "sum");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId);
      const first = await createBooking(owner, tenant, customer.id, { endsDaysAgo: 60 });
      await createBooking(owner, tenant, customer.id, { endsDaysAgo: 30 });
      await createBooking(owner, tenant, customer.id, { endsDaysAgo: 10, status: "no_show" });
      const paid = await payment(tenant, { appointmentId: first, amountMinor: 100_000 });
      await owner`insert into payment_refunds (tenant_id, payment_id, amount_minor, reason) values (${tenant.tenantId}, ${paid}, 20_000, 'Test')`;
      const note = await createNote(context, customer.id, { body: "Allergic to latex", pinned: true }, key());
      const summary = await loadCustomerSummary(context, customer.id);
      expect(summary.visits).toBe(2);
      expect(summary.noShows).toBe(1);
      expect(summary.lifetimeValueMinor).toBe(80_000);
      expect(summary.averageGapDays).toBe(30);
      expect(summary.pinnedNote?.id).toBe(note.id);
      const blind = await loadCustomerSummary(staffContext(tenant, { role: "read_only", permissions: resolvePermissions("read_only", {}) }), customer.id);
      expect(blind.lifetimeValueMinor).toBeNull();
      expect(blind.balanceOwedMinor).toBeNull();
    });
  });

  describe("notes, tags and extra fields", () => {
    it("keeps note text out of the audit trail, checks versions and lets only the author or a manager change the words", async () => {
      const tenant = await createTenant(owner, "notes");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId);
      const secret = "Owes a favour to the dentist next door";
      const idem = key();
      const created = await createNote(context, customer.id, { body: secret, pinned: false }, idem);
      const replay = await createNote(context, customer.id, { body: secret, pinned: false }, idem);
      expect(replay.id).toBe(created.id);
      expect(await listNotes(context, customer.id)).toHaveLength(1);
      const audit = await owner`select metadata::text as metadata from audit_events where tenant_id = ${tenant.tenantId} and action like 'customer.note.%'`;
      expect(audit.length).toBeGreaterThan(0);
      expect(audit.every((row) => !String(row.metadata).includes(secret))).toBe(true);
      const updated = await updateNote(context, customer.id, created.id, { body: "Changed", version: created.version });
      await expectApiError(updateNote(context, customer.id, created.id, { body: "Stale", version: created.version }), "version_conflict");
      const stranger = staffContext(tenant, { role: "receptionist", permissions: resolvePermissions("receptionist", {}) });
      await expectApiError(updateNote(stranger, customer.id, created.id, { body: "Hijack", version: updated.version }), "forbidden");
      const pinned = await updateNote(stranger, customer.id, created.id, { pinned: true, version: updated.version });
      expect(pinned.pinned).toBe(true);
      await expectApiError(deleteNote(stranger, customer.id, created.id), "forbidden");
      await deleteNote(context, customer.id, created.id);
      expect(await listNotes(context, customer.id)).toHaveLength(0);
    });

    it("moves the pin when another note is pinned", async () => {
      const tenant = await createTenant(owner, "pin");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId);
      const one = await createNote(context, customer.id, { body: "one", pinned: true }, key());
      const two = await createNote(context, customer.id, { body: "two", pinned: true }, key());
      const notes = await listNotes(context, customer.id);
      expect(notes.find((note) => note.id === one.id)?.pinned).toBe(false);
      expect(notes.find((note) => note.id === two.id)?.pinned).toBe(true);
    });

    it("sets tags as a set, refuses duplicates by name and counts who carries each", async () => {
      const tenant = await createTenant(owner, "tags");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId);
      const vip = await createTag(context, { name: "VIP", color: "red" });
      await expectApiError(createTag(context, { name: "vip", color: "blue" }), "tag_exists");
      const mornings = await createTag(context, { name: "Prefers mornings", color: "green" });
      await setCustomerTags(context, customer.id, [vip.id, mornings.id]);
      await setCustomerTags(context, customer.id, [vip.id, vip.id]);
      const tags = await listTags(context);
      expect(tags.find((tag) => tag.id === vip.id)?.count).toBe(1);
      expect(tags.find((tag) => tag.id === mornings.id)?.count).toBe(0);
      await expectApiError(setCustomerTags(context, customer.id, ["nonexistent"]), "tag_not_found");
    });

    it("keeps tags and fields of one business out of another", async () => {
      const tag = await createTag(staffContext(a), { name: `Only A ${randomUUID().slice(0, 4)}`, color: "pink" });
      expect((await listTags(staffContext(b))).some((other) => other.id === tag.id)).toBe(false);
      const customerB = await createCustomer(owner, b.tenantId);
      await expectApiError(setCustomerTags(staffContext(b), customerB.id, [tag.id]), "tag_not_found");
    });

    it("checks each custom field's value against its kind", async () => {
      const tenant = await createTenant(owner, "fields");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId);
      const allergy = await createFieldDefinition(context, { label: "Allergies", kind: "text", choices: [] });
      const year = await createFieldDefinition(context, { label: "Class year", kind: "number", choices: [] });
      const joined = await createFieldDefinition(context, { label: "Joined", kind: "date", choices: [] });
      const level = await createFieldDefinition(context, { label: "Level", kind: "choice", choices: ["Beginner", "Advanced"] });
      const saved = await setFieldValues(context, customer.id, { [allergy.id]: "Latex", [year.id]: "3", [joined.id]: "2026-02-03", [level.id]: "Advanced" });
      expect(saved).toHaveLength(4);
      await expect(setFieldValues(context, customer.id, { [year.id]: "three", [joined.id]: "2026-02-31", [level.id]: "Expert" })).rejects.toMatchObject({ code: "validation_error" });
      const cleared = await setFieldValues(context, customer.id, { [allergy.id]: null });
      expect(cleared).toHaveLength(3);
      const audit = await owner`select metadata::text as metadata from audit_events where tenant_id = ${tenant.tenantId} and action = 'customer.fields.changed'`;
      expect(audit.every((row) => !String(row.metadata).includes("Latex"))).toBe(true);
    });
  });

  describe("blocking", () => {
    it("blocks and unblocks, records who and why, and refuses an online booking by the same email or phone", async () => {
      const tenant = await createTenant(owner, "block");
      const context = staffContext(tenant);
      const customer = await createCustomer(owner, tenant.tenantId, { email: "blocked.person@example.com", phone: "+919811122233" });
      await blockCustomer(context, customer.id, "Missed four visits without a call");
      const summary = await loadCustomerSummary(context, customer.id);
      expect(summary.blocked?.reason).toBe("Missed four visits without a call");
      const check = (contact: { email?: string; phone?: string }) => withTenant(tenant.tenantId, (transaction) => assertNotBlocked(transaction, tenant.tenantId, contact));
      await expectApiError(check({ email: "BLOCKED.person@example.com" }), "customer_blocked");
      await expectApiError(check({ phone: "098111 22233" }), "customer_blocked");
      await expect(check({ email: "someone.else@example.com", phone: "+919800000001" })).resolves.toBeUndefined();
      await unblockCustomer(context, customer.id);
      await expect(check({ email: "blocked.person@example.com" })).resolves.toBeUndefined();
      expect((await loadCustomerSummary(context, customer.id)).blocked).toBeNull();
    });

    it("never blocks across businesses", async () => {
      const tenant = await createTenant(owner, "block2");
      const customer = await createCustomer(owner, tenant.tenantId, { email: "only.here@example.com" });
      await blockCustomer(staffContext(tenant), customer.id, "Reason given");
      await expect(withTenant(b.tenantId, (transaction) => assertNotBlocked(transaction, b.tenantId, { email: "only.here@example.com" }))).resolves.toBeUndefined();
    });
  });

  describe("duplicates and merging", () => {
    async function pair(label: string) {
      const tenant = await createTenant(owner, label);
      const context = staffContext(tenant);
      const keep = await createCustomer(owner, tenant.tenantId, { firstName: "Asha", lastName: "Rao", phone: "+919822200001", email: "asha@example.com" });
      const merge = await createCustomer(owner, tenant.tenantId, { firstName: "Asha", lastName: "Rao", phone: "098222 00001", email: "asha.rao@example.com", dateOfBirth: null });
      return { tenant, context, keep, merge };
    }

    it("suggests pairs with the same phone, the same email or a similar name and birth date", async () => {
      const { context, keep, merge } = await pair("dups");
      const suggestions = await suggestDuplicates(context);
      const found = suggestions.find((entry) => [entry.a.id, entry.b.id].sort().join() === [keep.id, merge.id].sort().join());
      expect(found?.reasons).toContain("Same phone number");
      await expect(suggestDuplicates(staffContext(b))).resolves.not.toContainEqual(expect.objectContaining({ a: expect.objectContaining({ id: keep.id }) }));
    });

    it("moves every appointment, payment and invoice's worth of history to the kept profile and can be undone", async () => {
      const { tenant, context, keep, merge } = await pair("merge");
      const visitKeep = await createBooking(owner, tenant, keep.id, { endsDaysAgo: 40 });
      const visitMerged = await createBooking(owner, tenant, merge.id, { endsDaysAgo: 20 });
      await payment(tenant, { appointmentId: visitKeep, amountMinor: 10_000 });
      await payment(tenant, { appointmentId: visitMerged, amountMinor: 20_000 });
      // A sale with no visit: money rows are never edited, so it stays on the merged profile and is read through the merge.
      await payment(tenant, { patientId: merge.id, amountMinor: 5_000 });
      const note = await createNote(context, merge.id, { body: "From the old profile", pinned: false }, key());
      const tag = await createTag(context, { name: "Regular", color: "teal" });
      await setCustomerTags(context, merge.id, [tag.id]);
      await consent(tenant.tenantId, merge.id, true);

      const result = await mergeCustomers(context, { keepId: keep.id, mergeId: merge.id }, key());
      expect(result.moved.appointments).toBe(1);
      expect(result.moved.payments).toBe(2);

      const appointments = await owner`select id, patient_id from appointments where tenant_id = ${tenant.tenantId} and patient_id in (${keep.id}, ${merge.id})`;
      expect(appointments.every((row) => row.patient_id === keep.id)).toBe(true);
      expect(appointments).toHaveLength(2);
      const summary = await loadCustomerSummary(context, keep.id);
      expect(summary.visits).toBe(2);
      expect(summary.lifetimeValueMinor).toBe(35_000);
      expect((await listNotes(context, keep.id)).map((entry) => entry.id)).toContain(note.id);
      expect(summary.tags.map((entry) => entry.id)).toContain(tag.id);
      expect(summary.recentMerge?.id).toBe(result.mergeId);
      // The merged profile is hidden and loses its contact details, so it is never matched as a returning customer.
      await expectApiError(loadCustomerSummary(context, merge.id), "customer_not_found");
      const [stub] = await owner<{ phone: string; email: string; merged_into_id: string }[]>`select phone, email, merged_into_id from patients where id = ${merge.id}`;
      expect(stub).toMatchObject({ phone: "", merged_into_id: keep.id });
      expect(stub!.email).not.toContain("asha");
      // The kept profile keeps its own consent: the merged one's yes is not carried over.
      const members = await withTenant(tenant.tenantId, (transaction) => countSegmentIn(transaction, tenant.tenantId, { all: [{ field: "marketingConsent", value: true }] }));
      expect(members).toBe(0);
      const timeline = await loadTimeline(context, keep.id, { kinds: ["payment"] });
      expect(timeline.entries).toHaveLength(3);

      // A second merge of the same profile is refused.
      await expectApiError(mergeCustomers(context, { keepId: keep.id, mergeId: merge.id }, key()), "already_merged");

      await undoMerge(context, result.mergeId);
      const [restored] = await owner<{ phone: string; email: string; merged_into_id: string | null }[]>`select phone, email, merged_into_id from patients where id = ${merge.id}`;
      expect(restored).toMatchObject({ phone: merge.phone, email: merge.email, merged_into_id: null });
      const afterUndo = await owner`select id, patient_id from appointments where tenant_id = ${tenant.tenantId} and id in (${visitKeep}, ${visitMerged})`;
      expect(afterUndo.find((row) => row.id === visitMerged)?.patient_id).toBe(merge.id);
      expect(afterUndo.find((row) => row.id === visitKeep)?.patient_id).toBe(keep.id);
      expect((await loadCustomerSummary(context, keep.id)).lifetimeValueMinor).toBe(10_000);
      expect((await loadCustomerSummary(context, merge.id)).lifetimeValueMinor).toBe(25_000);
      await expectApiError(undoMerge(context, result.mergeId), "merge_undone");
    });

    it("replays the same Idempotency-Key and needs the permission and a recent second-factor check", async () => {
      const { context, keep, merge, tenant } = await pair("merge2");
      const idem = key();
      const first = await mergeCustomers(context, { keepId: keep.id, mergeId: merge.id }, idem);
      const again = await mergeCustomers(context, { keepId: keep.id, mergeId: merge.id }, idem);
      expect(again.mergeId).toBe(first.mergeId);
      const stale = staffContext(tenant, { secondFactorAt: new Date(Date.now() - 60 * 60_000) });
      const other = await createCustomer(owner, tenant.tenantId);
      const another = await createCustomer(owner, tenant.tenantId);
      await expectApiError(mergeCustomers(stale, { keepId: other.id, mergeId: another.id }, key()), "step_up_required");
      const receptionist = staffContext(tenant, { role: "receptionist", permissions: resolvePermissions("receptionist", {}) });
      await expectApiError(mergeCustomers(receptionist, { keepId: other.id, mergeId: another.id }, key()), "forbidden");
      const reader = staffContext(tenant, { impersonation: { writeAccess: false } } as never);
      await expectApiError(mergeCustomers(reader, { keepId: other.id, mergeId: another.id }, key()), "read_only_support_session");
    });

    it("refuses to undo after 30 days, and the daily job then drops the saved details", async () => {
      const { context, keep, merge, tenant } = await pair("merge3");
      const result = await mergeCustomers(context, { keepId: keep.id, mergeId: merge.id }, key());
      await owner`update customer_merges set undo_until = now() - interval '1 day' where id = ${result.mergeId}`;
      await expectApiError(undoMerge(context, result.mergeId), "undo_expired");
      const summary = await purgeMergeSnapshots(worker);
      expect(summary.rows).toBeGreaterThanOrEqual(1);
      const [row] = await owner<{ snapshot_ciphertext: string | null }[]>`select snapshot_ciphertext from customer_merges where id = ${result.mergeId}`;
      expect(row?.snapshot_ciphertext).toBeNull();
      expect(tenant.tenantId).toBeTruthy();
    });

    it("cannot merge across businesses", async () => {
      const mine = await createCustomer(owner, a.tenantId);
      const theirs = await createCustomer(owner, b.tenantId);
      await expectApiError(mergeCustomers(staffContext(a), { keepId: mine.id, mergeId: theirs.id }, key()), "customer_not_found");
    });
  });
});
