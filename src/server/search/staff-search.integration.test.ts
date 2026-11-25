/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { StaffRole } from "@/lib/permissions";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createBooking, createCustomer, createTenant, type TenantFixture } from "@/test/privacy-fixture";
import { staffContext } from "@/test/billing-fixture";

vi.mock("server-only", () => ({}));

import { searchStaff } from "@/server/search/staff-search";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeDb = isolatedDatabaseReady(runtimeUrl, ownerUrl) ? describe : describe.skip;

describeDb("staff search (feature 29)", () => {
  let owner: postgres.Sql;
  let a: TenantFixture;
  let b: TenantFixture;
  let nurseUserId: string;
  let nursePractitionerId: string;
  let otherCustomerId: string;
  let ownCustomerId: string;

  const kindsOf = async (fixture: TenantFixture, role: StaffRole, query: string, overrides = {}) =>
    [...new Set((await searchStaff(staffContext(fixture, role, overrides), query, 10)).hits.map((hit) => hit.kind))].sort();

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 4, prepare: false });
    a = await createTenant(owner, "srch-a");
    b = await createTenant(owner, "srch-b");

    // The same words in both businesses, so a leak across businesses would show.
    for (const fixture of [a, b]) {
      await createCustomer(owner, fixture.tenantId, { firstName: "Meera", lastName: "Quartzwright", phone: "+919811122233", email: "meera.q@example.com" });
      await owner`update services set name = 'Quartz dermatology consult', category = 'Skin' where tenant_id = ${fixture.tenantId}`;
      await owner`update practitioners set name = 'Dr Quartz Rao', specialty = 'Dermatology' where tenant_id = ${fixture.tenantId}`;
      await owner`insert into routing_forms (tenant_id, name, slug, definition) values (${fixture.tenantId}, 'Quartz intake form', ${`quartz-${randomUUID().slice(0, 6)}`}, '{}'::jsonb)`;
      await owner`insert into campaigns (tenant_id, name, kind, channel, code) values (${fixture.tenantId}, 'Quartz winter recall', 'one_off', 'email', ${randomUUID().slice(0, 12)})`;
    }

    // A second person in business A with their own customer, to test "own customers only".
    nurseUserId = randomUUID();
    await owner`insert into auth_users (id, name, email, email_verified) values (${nurseUserId}, 'Nurse', ${`nurse-${nurseUserId}@example.com`}, true)`;
    const [nurse] = await owner<{ id: string }[]>`
      insert into practitioners (tenant_id, auth_user_id, name, title, initials, specialty) values (${a.tenantId}, ${nurseUserId}, 'Nurse Nandini', 'Nurse', 'NN', 'Care') returning id`;
    nursePractitionerId = nurse!.id;
    ownCustomerId = (await createCustomer(owner, a.tenantId, { firstName: "Ownly", lastName: "Quartzville" })).id;
    otherCustomerId = (await createCustomer(owner, a.tenantId, { firstName: "Elsewhere", lastName: "Quartzville" })).id;
    await owner`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, reason_for_visit)
      values (${a.tenantId}, ${a.locationId}, ${ownCustomerId}, ${nursePractitionerId}, ${a.serviceId}, now() + interval '1 day', now() + interval '1 day 30 minutes', 'booked', 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, 'Sore shoulder')`;
    await createBooking(owner, a, otherCustomerId);
    const [mainCustomer] = await owner<{ id: string }[]>`select id from patients where tenant_id = ${a.tenantId} and last_name = 'Quartzwright'`;
    await owner`
      with made as (
        insert into invoices (tenant_id, financial_year, series, sequence, number, patient_id, location_id, kind, currency, prices_include_tax, taxable_minor, total_minor, supply, seller_legal_name, buyer_name)
        values (${a.tenantId}, '2026-27', 'INV', 1, 'INV/2026-27/0001', ${mainCustomer!.id}, ${a.locationId}, 'tax_invoice', 'INR', false, 1000, 1000, 'none', 'Seller LLP', 'Meera Quartzwright')
        returning id)
      insert into invoice_lines (tenant_id, invoice_id, position, description, quantity, unit_price_minor, treatment, taxable_minor, total_minor)
      select ${a.tenantId}, id, 1, 'Consult', 1, 1000, 'nil', 1000, 1000 from made`;
  }, 60_000);
  afterAll(async () => { await owner?.end(); });

  it("finds each kind of record by a word in it, and shows where to open it", async () => {
    const hits = (await searchStaff(staffContext(a, "owner"), "quartz", 10)).hits;
    expect(new Set(hits.map((hit) => hit.kind))).toEqual(new Set(["customer", "appointment", "service", "person", "campaign", "invoice", "routing_form"]));
    const customer = hits.find((hit) => hit.kind === "customer" && hit.title === "Meera Quartzwright");
    expect(customer?.subtitle).toBe("+919811122233");
    const appointment = hits.find((hit) => hit.kind === "appointment");
    expect(appointment?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(appointment?.customerId).toBeTruthy();
    const invoice = (await searchStaff(staffContext(a, "owner"), "0001", 10)).hits.find((hit) => hit.kind === "invoice");
    expect(invoice?.title).toBe("INV/2026-27/0001");
    expect(invoice?.customerId).toBeTruthy();
  });

  it("matches a phone number, an email, a reason for the visit and a service's category", async () => {
    const owner_ = staffContext(a, "owner");
    expect((await searchStaff(owner_, "98111 222", 10)).hits.some((hit) => hit.title === "Meera Quartzwright")).toBe(true);
    expect((await searchStaff(owner_, "meera.q@exa", 10)).hits.some((hit) => hit.title === "Meera Quartzwright")).toBe(true);
    expect((await searchStaff(owner_, "shoulder", 10)).hits.some((hit) => hit.kind === "appointment")).toBe(true);
    expect((await searchStaff(owner_, "derm skin", 10)).hits.some((hit) => hit.kind === "service")).toBe(true);
  });

  it("tolerates a typo in a name", async () => {
    const hits = (await searchStaff(staffContext(a, "owner"), "Meara Quartzwrite", 10)).hits;
    expect(hits.some((hit) => hit.title === "Meera Quartzwright")).toBe(true);
  });

  it("never returns another business's records", async () => {
    const forA = (await searchStaff(staffContext(a, "owner"), "quartz", 20)).hits;
    const forB = (await searchStaff(staffContext(b, "owner"), "quartz", 20)).hits;
    expect(forB.some((hit) => hit.id === ownCustomerId || hit.id === nursePractitionerId)).toBe(false);
    const idsA = new Set(forA.map((hit) => hit.id));
    for (const hit of forB) expect(idsA.has(hit.id)).toBe(false);
    expect(forB.length).toBeGreaterThan(0);
  });

  it("returns nothing when the business is not set, even called directly", async () => {
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    try {
      const rows = await runtime`select * from kalendr_staff_search(array['customer','service']::text[], 'quartz', null, 10)`;
      expect(rows).toHaveLength(0);
    } finally { await runtime.end(); }
  });

  it("shows each role only what its screens open", async () => {
    expect(await kindsOf(a, "owner", "quartz")).toEqual(["appointment", "campaign", "customer", "invoice", "person", "routing_form", "service"]);
    // The receptionist cannot run campaigns; the billing role cannot book, so it sees customers (to take payment) and invoices.
    expect(await kindsOf(a, "receptionist", "quartz")).not.toContain("campaign");
    expect(await kindsOf(a, "receptionist", "0001")).toContain("invoice");
    const billing = await kindsOf(a, "billing", "quartz");
    expect(billing).not.toContain("campaign");
    expect(billing).not.toContain("appointment");
    expect(billing).not.toContain("service");
    expect(await kindsOf(a, "billing", "0001")).toContain("invoice");
    expect(await kindsOf(a, "practitioner", "0001", { userId: nurseUserId })).not.toContain("invoice");
    expect(await kindsOf(a, "read_only", "quartz")).toEqual([]);
  });

  it("keeps a team member to their own customers and appointments", async () => {
    const nurse = staffContext(a, "practitioner", { userId: nurseUserId });
    const hits = (await searchStaff(nurse, "quartzville", 10)).hits;
    expect(hits.filter((hit) => hit.kind === "customer").map((hit) => hit.id)).toEqual([ownCustomerId]);
    expect(hits.filter((hit) => hit.kind === "appointment").map((hit) => hit.customerId)).toEqual([ownCustomerId]);
    // The owner sees both.
    const all = (await searchStaff(staffContext(a, "owner"), "quartzville", 10)).hits.filter((hit) => hit.kind === "customer");
    expect(all.map((hit) => hit.id)).toEqual(expect.arrayContaining([ownCustomerId, otherCustomerId]));
    // A team member with no linked profile sees no customers at all.
    const stranger = staffContext(a, "practitioner", { userId: randomUUID() });
    expect((await searchStaff(stranger, "quartzville", 10)).hits.filter((hit) => hit.kind === "customer" || hit.kind === "appointment")).toEqual([]);
  });

  it("treats wildcard, query syntax and SQL in the text as plain text", async () => {
    const context = staffContext(a, "owner");
    for (const text of ["%%", "__", "\\", "a & b | !c", ":*", "'; drop table patients; --", "(((", "\u0000x", "x".repeat(500)]) {
      await expect(searchStaff(context, text, 5)).resolves.toBeDefined();
    }
    expect((await searchStaff(context, "%%", 10)).hits).toEqual([]);
    expect((await searchStaff(context, "a", 10)).hits).toEqual([]);
    const [{ count }] = await owner<{ count: string }[]>`select count(*) from patients where tenant_id = ${a.tenantId}`;
    expect(Number(count)).toBeGreaterThan(0);
  });

  describe("at 100,000 rows", () => {
    let big: TenantFixture;
    beforeAll(async () => {
      big = await createTenant(owner, "srch-big");
      const pre = `bp${randomUUID().slice(0, 6)}-`;
      const first = ["Asha", "Ravi", "Meera", "Imran", "Priya", "Dev", "Nina", "Omar"];
      const last = ["Rao", "Shah", "Khan", "Iyer", "Nair", "Das"];
      await owner`
        insert into patients (id, tenant_id, first_name, last_name, phone, email, preferred_channel)
        select ${pre}::text || g, ${big.tenantId}, (${first}::text[])[1 + g % 8] || (g % 977), (${last}::text[])[1 + g % 6] || (g % 1301),
          '+9198' || lpad(g::text, 8, '0'), 'user' || g || '@example.test', 'email' from generate_series(1, 100000) g`;
      await owner`insert into patients (id, tenant_id, first_name, last_name, phone, email, preferred_channel) values (${pre}::text || '-needle', ${big.tenantId}, 'Zoltan', 'Haverford', '+919000000001', 'zoltan.h@example.test', 'email')`;
      await owner`
        insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, reason_for_visit)
        select ${big.tenantId}, ${big.locationId}, ${pre}::text || g, ${big.practitionerId}, ${big.serviceId}, now() - g * interval '7 minutes', now() - g * interval '7 minutes' + interval '30 minutes', 'completed', 'staff',
          md5(${pre}::text || g) || md5(g || ${pre}::text), case when g % 5000 = 0 then 'Unusual lumbar complaint ' || g else 'Routine visit ' || (g % 40) end from generate_series(1, 100000) g`;
      // The invoice sum check runs once per row against the lines table, so a bulk fixture switches it off and back on inside one
      // transaction: nothing else ever sees it off.
      await owner.begin(async (tx) => {
        await tx`alter table invoices disable trigger invoices_sums_check`;
        await tx`
          insert into invoices (tenant_id, financial_year, series, sequence, number, patient_id, location_id, kind, currency, prices_include_tax, taxable_minor, total_minor, supply, seller_legal_name, buyer_name)
          select ${big.tenantId}, '2026-27', 'INV', g, 'INV/2026-27/' || lpad(g::text, 6, '0'), ${pre}::text || g, ${big.locationId}, 'tax_invoice', 'INR', false, 1000, 1000, 'none', 'Seller LLP', 'Buyer ' || g from generate_series(1, 100000) g`;
        await tx`alter table invoices enable trigger invoices_sums_check`;
      });
      await owner`
        insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types, slug)
        select ${big.tenantId}, 'Service ' || g || ' ' || (array['laser','massage','dental','physio'])[1 + g % 4], 'About service ' || g, 30, 'instant', ${["new"]}::text[], 's' || g from generate_series(1, 20000) g`;
      await owner`analyze patients`;
      await owner`analyze appointments`;
      await owner`analyze invoices`;
      await owner`analyze services`;
    }, 240_000);

    it("answers in well under a second, by name, phone, email, reason, invoice number and service", async () => {
      const context = staffContext(big, "owner");
      const cases: [string, SearchKindName][] = [
        ["Haverford", "customer"], ["9000000001", "customer"], ["zoltan.h@exam", "customer"], ["lumbar", "appointment"],
        ["000777", "invoice"], ["Buyer 99999", "invoice"], ["Service 19999 physio", "service"],
      ];
      for (const [text, kind] of cases) {
        const started = performance.now();
        const { hits } = await searchStaff(context, text, 5);
        const took = performance.now() - started;
        expect(hits.some((hit) => hit.kind === kind), `${text} finds a ${kind}`).toBe(true);
        expect(took, `${text} took ${Math.round(took)} ms`).toBeLessThan(600);
      }
    });

    it("uses the indexes: every matcher is a bitmap index scan, not a scan of the table", async () => {
      // The function runs as the table owner (see the migration), so its plans are the owner's plans.
      const plans = async (statement: string): Promise<string> => (await owner.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${big.tenantId}, true)`;
        return tx.unsafe(`explain ${statement}`);
      })).map((row) => String(row["QUERY PLAN"])).join("\n");
      const t = `'${big.tenantId}'`;
      const checks: [string, string, string][] = [
        ["customer name", `select id from patients where tenant_id = ${t} and (first_name || ' ' || last_name) ilike '%haverf%'`, "patients_fullname_trgm_idx"],
        ["customer typo", `select id from patients where tenant_id = ${t} and 'haverfrd' <% (first_name || ' ' || last_name)`, "patients_fullname_trgm_idx"],
        ["customer email", `select id from patients where tenant_id = ${t} and email ilike '%zoltan.h%'`, "patients_email_trgm_idx"],
        ["customer phone", `select id from patients where tenant_id = ${t} and regexp_replace(phone, '\\D', '', 'g') like '%9000000001%'`, "patients_phone_digits_trgm_idx"],
        ["appointment reason", `select id from appointments where tenant_id = ${t} and to_tsvector('simple', coalesce(reason_for_visit, '')) @@ to_tsquery('simple', 'lumbar:*') and reason_for_visit is not null`, "appointments_reason_fts_idx"],
        ["invoice number", `select id from invoices where tenant_id = ${t} and number ilike '%000777%'`, "invoices_number_trgm_idx"],
        ["invoice buyer", `select id from invoices where tenant_id = ${t} and buyer_name ilike '%Buyer 99999%'`, "invoices_buyer_trgm_idx"],
        ["service text", `select id from services where tenant_id = ${t} and to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(category, '') || ' ' || coalesce(description, '')) @@ to_tsquery('simple', 'physio:*')`, "services_search_fts_idx"],
      ];
      for (const [label, statement, index] of checks) {
        const plan = await plans(statement);
        expect(plan, `${label}: ${plan}`).toContain(index);
        expect(plan, `${label} must not scan the table: ${plan}`).not.toMatch(/Seq Scan/);
      }
    });
  });
});

type SearchKindName = "customer" | "appointment" | "service" | "person" | "invoice" | "campaign";
