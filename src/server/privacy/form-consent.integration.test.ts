/** @vitest-environment node */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createCustomer, createTenant, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { applyFormMessagingConsentIn, withdrawConsent, type FormMatch } from "@/server/privacy/consent";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

describeLocal("the visit-messages box on public forms", () => {
  let owner: postgres.Sql;
  let fixture: TenantFixture;

  const apply = (patientId: string, agreed: boolean, match: FormMatch) =>
    withTenant(fixture.tenantId, (transaction) => applyFormMessagingConsentIn(transaction, fixture.tenantId, patientId, { agreed, match }));

  async function stateOf(patientId: string) {
    const [patient] = await owner<{ messaging_consent_at: Date | null }[]>`select messaging_consent_at from patients where id = ${patientId}`;
    const ledger = await owner<{ granted: boolean; source: string }[]>`
      select granted, source from consent_records where patient_id = ${patientId} and purpose = 'appointment_messages' order by created_at, id
    `;
    return { consented: patient!.messaging_consent_at !== null, ledger };
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    fixture = await createTenant(owner, "form-consent");
  });

  afterAll(async () => {
    await owner.end();
  });

  it("a door check-in (phone and first name only) can't undo a STOP", async () => {
    const customer = await createCustomer(owner, fixture.tenantId);
    await withdrawConsent(fixture.tenantId, customer.id, "appointment_messages", { source: "whatsapp_stop" });

    await expect(apply(customer.id, true, "partial")).resolves.toEqual({ changed: false });
    expect(await stateOf(customer.id)).toEqual({ consented: false, ledger: [{ granted: false, source: "whatsapp_stop" }] });
  });

  it("a door check-in fills in a yes only for someone who never answered, and never withdraws", async () => {
    const customer = await createCustomer(owner, fixture.tenantId);
    await expect(apply(customer.id, false, "partial")).resolves.toEqual({ changed: false });
    expect(await stateOf(customer.id)).toEqual({ consented: false, ledger: [] });

    await expect(apply(customer.id, true, "partial")).resolves.toEqual({ changed: true });
    expect(await stateOf(customer.id)).toEqual({ consented: true, ledger: [{ granted: true, source: "booking" }] });
    await expect(apply(customer.id, false, "partial")).resolves.toEqual({ changed: false });
    expect((await stateOf(customer.id)).consented).toBe(true);
  });

  it("a full match records the customer's answer either way, after a STOP too", async () => {
    const customer = await createCustomer(owner, fixture.tenantId);
    await withdrawConsent(fixture.tenantId, customer.id, "appointment_messages", { source: "whatsapp_stop" });

    await apply(customer.id, true, "full");
    expect(await stateOf(customer.id)).toMatchObject({ consented: true });
    await apply(customer.id, false, "full");
    expect(await stateOf(customer.id)).toEqual({
      consented: false,
      ledger: [{ granted: false, source: "whatsapp_stop" }, { granted: true, source: "booking" }, { granted: false, source: "booking" }],
    });
    // The same answer twice writes nothing new.
    await expect(apply(customer.id, false, "full")).resolves.toEqual({ changed: false });
  });

  it("puts the quick lookup back in step when older code left it out of line with the ledger", async () => {
    const customer = await createCustomer(owner, fixture.tenantId);
    await withdrawConsent(fixture.tenantId, customer.id, "appointment_messages", { source: "whatsapp_stop" });
    await owner`update patients set messaging_consent_at = now() where id = ${customer.id}`;

    await expect(apply(customer.id, false, "full")).resolves.toEqual({ changed: false });
    expect((await stateOf(customer.id)).consented).toBe(false);
  });
});
