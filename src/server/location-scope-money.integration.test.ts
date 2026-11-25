/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { invoiceListQuerySchema } from "@/lib/invoicing-contracts";
import { addMember, contextForMember } from "@/test/enterprise-fixture";
import { isLocalDatabase } from "@/test/billing-fixture";
import { createCustomer, createTenant, type TenantFixture } from "@/test/privacy-fixture";

import { closeDay, getDayEnd } from "@/server/day-end";
import { exportInvoicesCsv } from "@/server/invoicing/export";
import { getInvoice, getOutstanding, issueCreditNote, issueVisitInvoice, listInvoices } from "@/server/invoicing/invoice";
import { createInvoiceLink } from "@/server/invoicing/links";
import { sealManageToken } from "@/server/messaging/sealed-link";
import { connectPaymentAccount } from "@/server/payments/accounts";
import { createPaymentLink } from "@/server/payments/checkout";
import { closeQueueDay } from "@/server/queue-door";
import type { StaffContext } from "@/server/staff-context";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

/** Money screens for a business with two branches: an admin limited to the second sees and acts there only. */
describeLocal("branch-limited access to queue closing, day end, payment links and invoices", () => {
  let owner: postgres.Sql;
  let fixture: TenantFixture;
  let locationA = "";
  let locationB = "";
  let everyone: StaffContext;
  let limited: StaffContext;
  let visitA = "";
  let visitB = "";
  let customerA = "";
  let customerB = "";
  let invoiceA = "";
  let invoiceB = "";
  const today = new Date().toISOString().slice(0, 10);

  async function visit(locationId: string, patientId: string, starts: string, number = 1): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor)
      values (${fixture.tenantId}, ${locationId}, ${patientId}, ${fixture.practitionerId}, ${fixture.serviceId},
        ${starts}::timestamptz, ${starts}::timestamptz + interval '30 minutes', 'checked_in', 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, 50000)
      returning id`;
    const id = row!.id;
    // A sealed manage token is what lets a payment link be made for the visit.
    await owner`update appointments set manage_token_ciphertext = ${sealManageToken(fixture.tenantId, id, randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""))} where id = ${id}`;
    await owner`
      insert into queue_tickets (tenant_id, location_id, day, number, appointment_id)
      select ${fixture.tenantId}, location.id, (now() at time zone location.timezone)::date, ${number}, ${id} from locations location where location.id = ${locationId}`;
    return id;
  }

  const statusOf = async (id: string) => (await owner<{ status: string }[]>`select status::text as status from appointments where id = ${id}`)[0]!.status;

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    fixture = await createTenant(owner, "money");
    locationA = fixture.locationId;
    const [second] = await owner<{ id: string }[]>`
      insert into locations (tenant_id, name, address, city, timezone) values (${fixture.tenantId}, 'Second branch', '2 Test Road', 'Hyderabad', 'Asia/Kolkata') returning id`;
    locationB = second!.id;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${locationB}) on conflict do nothing`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${locationB}) on conflict do nothing`;

    everyone = await contextForMember(fixture, await addMember(owner, fixture.tenantId, "owner"));
    // Limited to the SECOND branch, so the "first location" fallback would be the wrong (other) branch.
    limited = await contextForMember(fixture, await addMember(owner, fixture.tenantId, "admin"), { locationIds: [locationB] });

    customerA = (await createCustomer(owner, fixture.tenantId)).id;
    customerB = (await createCustomer(owner, fixture.tenantId)).id;
    visitA = await visit(locationA, customerA, new Date(Date.now() + 40 * 60_000).toISOString());
    visitB = await visit(locationB, customerB, new Date(Date.now() + 80 * 60_000).toISOString());

    invoiceA = (await issueVisitInvoice(everyone, { appointmentId: visitA }, randomUUID())).id;
    invoiceB = (await issueVisitInvoice(limited, { appointmentId: visitB }, randomUUID())).id;
    await connectPaymentAccount(everyone, { provider: "fake" }, "http://localhost:3000");
  });

  afterAll(async () => {
    if (!owner) return;
    if (fixture) {
      await owner`delete from outbox_events where tenant_id = ${fixture.tenantId}`.catch(() => undefined);
      await owner`update tenants set is_active = false where id = ${fixture.tenantId}`.catch(() => undefined);
    }
    await owner.end();
  });

  it("day end: a limited person gets their own branch by default, is refused another, and the owner reaches both", async () => {
    const mine = await getDayEnd(limited, {});
    expect(mine.summary.locationId).toBe(locationB);
    await expect(getDayEnd(limited, { locationId: locationA })).rejects.toMatchObject({ status: 403, code: "location_not_allowed" });
    await expect(closeDay(limited, { day: today, locationId: locationA, cashCountedMinor: 0 }, randomUUID())).rejects.toMatchObject({ status: 403, code: "location_not_allowed" });
    expect((await owner`select 1 from day_closes where location_id = ${locationA}`).length).toBe(0);
    expect((await getDayEnd(everyone, {})).summary.locationId).toBe(locationA); // no limit: first created, as before
    expect((await getDayEnd(everyone, { locationId: locationB })).summary.locationId).toBe(locationB);
    // With no location named, the limited person's close lands on their own branch.
    const closed = await closeDay(limited, { day: today, cashCountedMinor: 0 }, randomUUID());
    expect(closed.summary.locationId).toBe(locationB);
    expect((await owner`select 1 from day_closes where location_id = ${locationA}`).length).toBe(0);
  });

  it("queue: a limited person closes only their own branch's queue", async () => {
    await expect(closeQueueDay(limited, { reason: "", locationId: locationA })).rejects.toMatchObject({ status: 403, code: "location_not_allowed" });
    expect(await statusOf(visitA)).toBe("checked_in");
    // No location named: their own (second) branch, not the first-created one.
    await closeQueueDay(limited, { reason: "" });
    expect(await statusOf(visitB)).toBe("cancelled");
    expect(await statusOf(visitA)).toBe("checked_in");
    // The owner, not limited, still closes any branch.
    await closeQueueDay(everyone, { reason: "", locationId: locationA });
    expect(await statusOf(visitA)).toBe("cancelled");
  });

  it("payment links: another branch's visit reads as not found, and the own branch's visit gets a link", async () => {
    await expect(createPaymentLink(limited, visitA, "http://localhost:3000")).rejects.toMatchObject({ status: 404 });
    // Cancelled by the queue test above, so use fresh visits.
    const freshA = await visit(locationA, customerA, new Date(Date.now() + 120 * 60_000).toISOString(), 2);
    const freshB = await visit(locationB, customerB, new Date(Date.now() + 140 * 60_000).toISOString(), 2);
    await expect(createPaymentLink(limited, freshA, "http://localhost:3000")).rejects.toMatchObject({ status: 404 });
    expect((await createPaymentLink(limited, freshB, "http://localhost:3000")).url).toContain("/pay/");
    expect((await createPaymentLink(everyone, freshA, "http://localhost:3000")).url).toContain("/pay/");
  });

  it("invoices: lists, exports and outstanding balances are limited to the branch; single invoices answer 404", async () => {
    const query = invoiceListQuerySchema.parse({});
    expect((await listInvoices(limited, query)).invoices.map((row) => row.id)).toEqual([invoiceB]);
    expect((await listInvoices(everyone, query)).invoices.map((row) => row.id).sort()).toEqual([invoiceA, invoiceB].sort());

    await expect(getInvoice(limited, invoiceA)).rejects.toMatchObject({ status: 404 });
    await expect(getInvoice(limited, invoiceB)).resolves.toBeDefined();
    await expect(getInvoice(everyone, invoiceA)).resolves.toBeDefined();

    expect((await getOutstanding(limited, customerA)).invoices).toEqual([]);
    expect((await getOutstanding(limited, customerB)).invoices.map((row) => row.id)).toEqual([invoiceB]);
    expect((await getOutstanding(everyone, customerA)).invoices.map((row) => row.id)).toEqual([invoiceA]);

    const month = new Date().toISOString().slice(0, 7);
    const limitedCsv = (await exportInvoicesCsv(limited, month, "documents")).body;
    const fullCsv = (await exportInvoicesCsv(everyone, month, "documents")).body;
    const numberOf = async (id: string) => (await owner<{ number: string }[]>`select number from invoices where id = ${id}`)[0]!.number;
    expect(limitedCsv).toContain(await numberOf(invoiceB));
    expect(limitedCsv).not.toContain(await numberOf(invoiceA));
    expect(fullCsv).toContain(await numberOf(invoiceA));
    expect(fullCsv).toContain(await numberOf(invoiceB));

    await expect(createInvoiceLink(limited, invoiceA, null, "http://localhost:3000")).rejects.toMatchObject({ status: 404 });
    await expect(createInvoiceLink(limited, invoiceB, null, "http://localhost:3000")).resolves.toBeDefined();
    await expect(createInvoiceLink(everyone, invoiceA, null, "http://localhost:3000")).resolves.toBeDefined();
  });

  it("invoices: issuing and crediting at another branch is refused as not found", async () => {
    const freshA = await visit(locationA, customerA, new Date(Date.now() + 160 * 60_000).toISOString(), 3);
    await expect(issueVisitInvoice(limited, { appointmentId: freshA }, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(issueCreditNote(limited, invoiceA, { reason: "Test" }, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(issueCreditNote(limited, invoiceB, { reason: "Test" }, randomUUID())).resolves.toBeDefined();
    await expect(issueCreditNote(everyone, invoiceA, { reason: "Test" }, randomUUID())).resolves.toBeDefined();
  });
});
