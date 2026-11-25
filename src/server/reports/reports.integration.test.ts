/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createCustomer, createTenant, type TenantFixture } from "@/test/privacy-fixture";
import { staffContext } from "@/test/billing-fixture";

vi.mock("server-only", () => ({}));

import { reportExportHandler } from "@/worker/reports";
import { ApiError } from "@/server/api-error";
import { downloadExport, requestExport, runReport } from "@/server/reports/service";
import type { StaffContext } from "@/server/staff-context";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeDb = isolatedDatabaseReady(runtimeUrl, ownerUrl) ? describe : describe.skip;

const RANGE = { from: "2026-09-01", to: "2026-09-30" };

describeDb("reports (feature 26)", () => {
  let owner: postgres.Sql;
  let a: TenantFixture;
  let b: TenantFixture;
  let secondPersonId = "";
  let secondUserId = "";
  let customers: string[] = [];

  async function appointment(fixture: TenantFixture, patientId: string, startsAtIso: string, options: {
    status?: string; minutes?: number; practitionerId?: string; test?: boolean; sample?: boolean; spam?: string; source?: string; utm?: string | null; price?: number;
  } = {}): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash,
        price_minor, is_test, is_sample, spam_state, utm_campaign, created_at)
      values (${fixture.tenantId}, ${fixture.locationId}, ${patientId}, ${options.practitionerId ?? fixture.practitionerId}, ${fixture.serviceId},
        ${startsAtIso}::timestamptz, ${startsAtIso}::timestamptz + ${options.minutes ?? 30} * interval '1 minute', ${options.status ?? "completed"}, ${options.source ?? "online"},
        ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, ${options.price ?? 50000}, ${options.test ?? false}, ${options.sample ?? false},
        ${options.spam ?? "none"}, ${options.utm ?? null}, ${startsAtIso}::timestamptz - interval '2 days')
      returning id`;
    return row!.id;
  }

  const payment = (fixture: TenantFixture, appointmentId: string | null, amount: number, at: string, test = false) => owner`
    insert into payments (tenant_id, appointment_id, patient_id, location_id, amount_minor, currency, method, is_test, created_at)
    values (${fixture.tenantId}, ${appointmentId}, ${appointmentId ? null : customers[0]!}, ${appointmentId ? null : fixture.locationId}, ${amount}, 'INR', 'cash', ${test}, ${at}::timestamptz)
    returning id`;

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    a = await createTenant(owner, "reports-a");
    b = await createTenant(owner, "reports-b");
    customers = [];
    for (let index = 0; index < 8; index += 1) customers.push((await createCustomer(owner, a.tenantId)).id);
    const otherCustomer = (await createCustomer(owner, b.tenantId)).id;
    secondUserId = randomUUID();
    await owner`insert into auth_users (id, name, email, email_verified) values (${secondUserId}, 'Second', ${`second-${secondUserId}@example.com`}, true)`;
    const [second] = await owner<{ id: string }[]>`
      insert into practitioners (tenant_id, name, title, initials, specialty, auth_user_id) values (${a.tenantId}, 'Dr Second', 'Doctor', 'DS', 'General', ${secondUserId}) returning id`;
    secondPersonId = second!.id;

    // Counted: 6 completed + 2 no-shows + 1 booked = 9 bookings, 8 visits due. Times are IST; the last two sit either side of local midnight.
    for (let index = 0; index < 6; index += 1) await appointment(a, customers[index]!, `2026-09-1${index}T05:00:00Z`);
    await appointment(a, customers[6]!, "2026-09-15T05:00:00Z", { status: "no_show" });
    await appointment(a, customers[7]!, "2026-09-16T05:00:00Z", { status: "no_show" });
    await appointment(a, customers[0]!, "2026-09-17T05:00:00Z", { status: "booked", utm: "diwali" });
    // Edges: 23:30 IST on 30 September is inside (18:00Z), 00:30 IST on 1 October is outside (19:00Z the same UTC day), 23:30 IST on 31 August is outside.
    await appointment(a, customers[1]!, "2026-09-30T18:00:00Z", { utm: "diwali" });
    await appointment(a, customers[1]!, "2026-09-30T19:00:00Z");
    await appointment(a, customers[1]!, "2026-08-31T18:00:00Z");
    // Decoys that never count.
    await appointment(a, customers[2]!, "2026-09-12T06:00:00Z", { test: true });
    await appointment(a, customers[2]!, "2026-09-12T07:00:00Z", { sample: true, test: true });
    await appointment(a, customers[2]!, "2026-09-12T08:00:00Z", { status: "entered_in_error" });
    await appointment(a, customers[2]!, "2026-09-12T09:00:00Z", { spam: "reported" });
    await appointment(a, customers[3]!, "2026-09-12T10:00:00Z", { status: "cancelled" });
    // Another business, same dates: it must never show up.
    for (let index = 0; index < 4; index += 1) await appointment(b, otherCustomer, `2026-09-1${index}T05:00:00Z`);
    // Second person: 2 bookings that are theirs alone.
    const own = await appointment(a, customers[4]!, "2026-09-18T05:00:00Z", { practitionerId: secondPersonId });
    await appointment(a, customers[5]!, "2026-09-18T06:00:00Z", { practitionerId: secondPersonId });

    const [first] = await owner<{ id: string }[]>`select id from appointments where tenant_id = ${a.tenantId} and starts_at = '2026-09-10T05:00:00Z' and practitioner_id = ${a.practitionerId}`;
    await payment(a, first!.id, 50000, "2026-09-10T06:00:00Z");
    await payment(a, own, 30000, "2026-09-18T06:00:00Z");
    await payment(a, null, 120000, "2026-09-20T06:00:00Z"); // a package sold with no visit
    await payment(a, first!.id, 99900, "2026-09-10T07:00:00Z", true); // a test payment
    await payment(a, first!.id, 77700, "2026-10-01T06:00:00Z"); // next month
    const [paid] = await owner<{ id: string }[]>`select id from payments where tenant_id = ${a.tenantId} and amount_minor = 50000`;
    await owner`insert into payment_refunds (tenant_id, payment_id, amount_minor, reason, created_at) values (${a.tenantId}, ${paid!.id}, 10000, 'Goodwill', '2026-09-11T06:00:00Z')`;
  }, 60_000);

  afterAll(async () => { await owner?.end(); });

  const owner_ = (fixture: TenantFixture = a): StaffContext => staffContext(fixture, "owner");
  const metric = (result: Awaited<ReturnType<typeof runReport>>, key: string) => result.metrics.find((item) => item.key === key)?.value;

  it("matches a hand count of bookings, revenue and no-shows for the month", async () => {
    const result = await runReport(owner_(), "overview", RANGE);
    // 9 counted + 1 at 23:30 IST on the 30th + 2 for the second person = 12 bookings.
    expect(metric(result, "bookings")).toBe(12);
    // 50000 + 30000 + 120000 received, less the 10000 refund; the test payment and next month's payment are left out.
    expect(metric(result, "revenue")).toBe(190000);
    // Two no-shows of 8 visits due that were completed or no-shows (8 + the 23:30 one + 2 for the second person = 11).
    expect(metric(result, "no_show_rate")).toBeCloseTo((2 / 11) * 100, 0);
  });

  it("counts the business's own day, not UTC", async () => {
    const result = await runReport(owner_(), "bookings", RANGE);
    const days = result.charts.find((chart) => chart.key === "by_day")!.rows.map((row) => row.day);
    expect(days).toContain("2026-09-30");
    expect(days).not.toContain("2026-10-01");
    expect(days).not.toContain("2026-08-31");
  });

  it("shows utilisation of 50% for 20 booked hours of 40 available", async () => {
    const c = await createTenant(owner, "reports-util");
    const [schedule] = await owner<{ id: string }[]>`
      insert into availability_schedules (tenant_id, practitioner_id, name, timezone, is_default) values (${c.tenantId}, ${c.practitionerId}, 'Working hours', 'Asia/Kolkata', true) returning id`;
    const patientId = (await createCustomer(owner, c.tenantId)).id;
    for (const day of [1, 2, 3, 4, 5]) {
      await owner`insert into availability_rules (tenant_id, location_id, practitioner_id, schedule_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from)
        values (${c.tenantId}, ${c.locationId}, ${c.practitionerId}, ${schedule!.id}, ${day}, '09:00', '17:00', 'Asia/Kolkata', '2026-01-01')`;
    }
    // Monday to Friday of 7 to 11 September 2026, 4 hours a day.
    for (const day of [7, 8, 9, 10, 11]) await appointment(c, patientId, `2026-09-${String(day).padStart(2, "0")}T04:00:00Z`, { minutes: 240 });
    const result = await runReport(owner_(c), "utilisation", { from: "2026-09-07", to: "2026-09-13" });
    expect(metric(result, "booked_hours")).toBe(20);
    expect(metric(result, "available_hours")).toBe(40);
    expect(metric(result, "utilisation")).toBe(50);
  });

  it("lists a booking made from a link with utm_campaign=diwali under that campaign", async () => {
    const result = await runReport(owner_(), "sources", RANGE);
    const row = result.tables.find((table) => table.key === "campaigns")!.rows.find((item) => item.campaign === "diwali");
    expect(row?.total).toBe(2);
    expect(String(row?.href)).toContain("utmCampaign=diwali");
  });

  it("gives a practitioner only their own numbers and no revenue", async () => {
    const practitioner = staffContext(a, "practitioner", { userId: secondUserId });
    const overview = await runReport(practitioner, "overview", { ...RANGE, practitionerId: a.practitionerId });
    // The staff filter in the request is ignored: this person is the second doctor.
    expect(metric(overview, "bookings")).toBe(2);
    expect(overview.scopedToPerson).toBe(true);
    expect(overview.metrics.some((item) => item.key === "revenue")).toBe(false);
    await expect(runReport(practitioner, "revenue", RANGE)).rejects.toMatchObject({ status: 403 });
    // Even with the revenue permission handed to them, only their own money shows.
    const withRevenue = { ...practitioner, permissions: resolvePermissions("practitioner", { "reports.revenue": true }) };
    const revenue = await runReport(withRevenue, "revenue", RANGE);
    expect(metric(revenue, "received")).toBe(30000);
  });

  it("keeps a practitioner with no profile from seeing the business", async () => {
    const stranger = staffContext(a, "practitioner", { userId: randomUUID() });
    const overview = await runReport(stranger, "overview", RANGE);
    expect(metric(overview, "bookings")).toBe(0);
  });

  it("never mixes in another business", async () => {
    const other = await runReport(owner_(b), "overview", RANGE);
    expect(metric(other, "bookings")).toBe(4);
  });

  it("refuses staff without reports.view and the plan gate without the feature", async () => {
    await expect(runReport(staffContext(a, "read_only"), "overview", RANGE)).rejects.toBeInstanceOf(ApiError);
    const noPlan = { ...owner_(), entitlements: { limits: { features: { reports: false } }, planKey: "free" } } as unknown as StaffContext;
    await expect(runReport(noPlan, "overview", RANGE)).rejects.toMatchObject({ status: 402 });
  });

  it("exports a short range as a clean CSV, and queues a long one for the worker", async () => {
    const sync = await requestExport(owner_(), { report: "overview", params: RANGE }, `key-${randomUUID()}`);
    expect(sync.kind).toBe("file");
    if (sync.kind !== "file") return;
    expect(sync.body.startsWith("﻿")).toBe(true);
    expect(sync.body).toContain("\r\n");
    expect(sync.body).toContain("Bookings,12");

    const key = `key-${randomUUID()}`;
    const long = { report: "bookings", params: { from: "2026-01-01", to: "2026-09-30" } };
    const queued = await requestExport(owner_(), long, key);
    expect(queued.kind).toBe("queued");
    // The same request again does not make a second job.
    expect(await requestExport(owner_(), long, key)).toEqual(queued);
    if (queued.kind !== "queued") return;
    const context = owner_();
    await expect(downloadExport(context, queued.id)).rejects.toMatchObject({ code: "export_not_found" });

    // The worker builds it; only the person who asked can download it.
    const asker = { ...context, userId: context.userId };
    const pendingRow = await owner<{ requested_by_user_id: string }[]>`select requested_by_user_id from report_exports where id = ${queued.id}`;
    const requester = { ...asker, userId: pendingRow[0]!.requested_by_user_id };
    await expect(downloadExport(requester, queued.id)).rejects.toMatchObject({ code: "export_pending" });
    await owner.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${a.tenantId}, true)`;
      const outcome = await reportExportHandler()(transaction, { id: "x", tenantId: a.tenantId, aggregateType: "report_export", aggregateId: queued.id, eventType: "report.export", payload: { exportId: queued.id }, dedupeKey: "k", attemptCount: 0 });
      expect(outcome).toBe("delivered");
    });
    const file = await downloadExport(requester, queued.id);
    expect(file.body.startsWith("﻿")).toBe(true);
    expect(file.filename).toBe("kalendr-bookings-2026-01-01-to-2026-09-30.csv");
    await expect(downloadExport({ ...requester, userId: randomUUID() }, queued.id)).rejects.toMatchObject({ code: "export_not_found" });
  });

  it("works out new against returning and the rebooking rate", async () => {
    const t = await createTenant(owner, "reports-customers");
    const [one, two, three, four] = await Promise.all([1, 2, 3, 4].map(async () => (await createCustomer(owner, t.tenantId)).id));
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    await appointment(t, one!, ago(200)); // first visit in the range, came back 10 days later
    await appointment(t, one!, ago(190));
    await appointment(t, two!, ago(200)); // first visit, never came back
    await appointment(t, three!, ago(5)); // too recent to judge a 30-day window
    await appointment(t, four!, ago(250)); // visited before the range: returning, not new
    await appointment(t, four!, ago(195));
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const result = await runReport(owner_(t), "customers", { from: day(210), to: day(0) });
    expect(metric(result, "new_customers")).toBe(3);
    expect(metric(result, "returning_customers")).toBe(1);
    // Eligible for 30 days: one (rebooked) and two (not) and four's first visit in range was not their first ever. 1 of 2.
    expect(metric(result, "rebook_30")).toBe(50);
  });

  it("splits the no-show rate by service and reports cancellations", async () => {
    const result = await runReport(owner_(), "noshows", RANGE);
    const byService = result.tables.find((table) => table.key === "by_service")!;
    expect(byService.rows[0]).toMatchObject({ name: "Check-up", no_shows: 2, due: 11 });
    expect(metric(result, "no_shows")).toBe(2);
  });

  it("answers the overview quickly with a lot of bookings", async () => {
    const big = await createTenant(owner, "reports-big");
    // 3,000 customers who each visit about 50 times: a busy business after a few years.
    await owner`
      insert into patients (id, tenant_id, first_name, last_name, phone, email, preferred_channel)
      select left(${big.tenantId}, 8) || '-' || n, ${big.tenantId}, 'Pat' || n, 'Big', '+9190000' || n, 'big' || n || '-' || left(${big.tenantId}, 8) || '@example.com', 'email' from generate_series(0, 2999) as n`;
    await owner`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor)
      select ${big.tenantId}, ${big.locationId}, left(${big.tenantId}, 8) || '-' || (n % 3000), ${big.practitionerId}, ${big.serviceId},
        timestamptz '2025-01-01 00:00:00+00' + (n * interval '5 minutes'), timestamptz '2025-01-01 00:00:00+00' + (n * interval '5 minutes') + interval '4 minutes',
        (array['completed','completed','completed','no_show','cancelled'])[1 + n % 5]::appointment_status, 'online', md5(${big.tenantId} || n::text) || md5(n::text || ${big.tenantId}), 50000
      from generate_series(0, 149999) as n`;
    await owner`analyze appointments`;
    const timings: Record<string, number> = {};
    for (const report of ["overview", "bookings", "utilisation", "noshows", "revenue", "customers", "sources"] as const) {
      const started = Date.now();
      const result = await runReport(owner_(big), report, { from: "2025-01-01", to: "2025-12-31" });
      timings[report] = Date.now() - started;
      if (report === "overview") expect(metric(result, "bookings")).toBeGreaterThan(50_000);
    }
    // A year of 150,000 bookings: every report answers within a few seconds.
    for (const [report, elapsed] of Object.entries(timings)) expect(elapsed, `${report} took ${elapsed} ms`).toBeLessThan(4_000);
    console.info("report timings (ms)", JSON.stringify(timings));
  }, 120_000);
});
