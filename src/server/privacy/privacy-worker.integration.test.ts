/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createBooking, createCustomer, createTenant, revokeWorkerOnlyFunctions, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { postgresDataKeyStore } from "@/server/keys/postgres-store";
import { forgetDataKeys, loadDataKeys } from "@/server/keys/ring";
import { openSecret } from "@/server/keys/secrets";
import { consumeExportDownload, createPortalRequest, setPortalConsent } from "@/server/privacy/portal";
import { decideRequest } from "@/server/privacy/requests";
import type { MessageSink } from "@/worker/delivery";
import { processNextOutboxEvent } from "@/worker/outbox-worker";
import { reEncryptTenant, rotateTenantKey } from "@/worker/storage-jobs";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

/** A sink that answers every send the same way, as the production sink does for a transient or a permanent failure. */
const answering = (outcome: Awaited<ReturnType<MessageSink["deliver"]>>): MessageSink => ({ mode: "local_capture", deliver: async () => outcome });

describeLocal("privacy work in the worker", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let runtime: postgres.Sql;

  const accountFor = async (email: string) => {
    const [row] = await owner<{ id: string }[]>`insert into patient_accounts (contact_kind, contact_value) values ('email', ${email}) returning id`;
    return { id: row!.id, contactKind: "email" as const, contactValue: email };
  };
  const runAgain = async (tenantId: string, sink?: MessageSink) => {
    await owner`update outbox_events set available_at = now() - interval '1 minute' where tenant_id = ${tenantId} and status = 'failed'`;
    return processNextOutboxEvent(worker, { tenantId, workerId: `f7-${randomUUID().slice(0, 6)}`, sink });
  };

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    runtime = postgres(runtimeUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    await revokeWorkerOnlyFunctions(owner, runtime);
  });
  afterAll(async () => {
    await Promise.all([owner.end(), worker.end(), runtime.end()]);
  });

  it("undoes an erasure whose notice needs a retry, then completes it and sends the notice", async () => {
    const f = await createTenant(owner, "retry-erase");
    const customer = await createCustomer(owner, f.tenantId);
    await createBooking(owner, f, customer.id, { notes: "Private note" });
    const account = await accountFor(customer.email);
    const { request } = await createPortalRequest(account, { clinicSlug: f.slug, patientId: customer.id, type: "erasure" });
    await decideRequest(staffContext(f), request.id, { decision: "approve", reason: "verified", version: request.version }, `k-${randomUUID()}`);

    // The provider is unavailable: nothing may be committed, and the address must still be there for the next try.
    const first = await processNextOutboxEvent(worker, { tenantId: f.tenantId, workerId: "f7-a", sink: answering({ outcome: "retry", code: "provider_unavailable" }) });
    expect(first.kind).toBe("retry");
    const [still] = await owner<{ first_name: string; email: string; erased_at: Date | null }[]>`select first_name, email, erased_at from patients where id = ${customer.id}`;
    expect(still).toMatchObject({ first_name: customer.firstName, email: customer.email, erased_at: null });
    expect((await owner<{ status: string }[]>`select status from data_requests where id = ${request.id}`)[0]!.status).toBe("approved");

    const second = await runAgain(f.tenantId);
    expect(second.kind).toBe("captured");
    const [done] = await owner<{ first_name: string; erased_at: Date | null }[]>`select first_name, erased_at from patients where id = ${customer.id}`;
    expect(done).toMatchObject({ first_name: "Erased" });
    expect(done!.erased_at).not.toBeNull();
    expect((await owner<{ status: string }[]>`select status from data_requests where id = ${request.id}`)[0]!.status).toBe("completed");
  });

  it("keeps an erasure done when the notice can never be delivered, and says so in the log", async () => {
    const f = await createTenant(owner, "dead-erase");
    const customer = await createCustomer(owner, f.tenantId);
    const account = await accountFor(customer.email);
    const { request } = await createPortalRequest(account, { clinicSlug: f.slug, patientId: customer.id, type: "erasure" });
    await decideRequest(staffContext(f), request.id, { decision: "approve", reason: "verified", version: request.version }, `k-${randomUUID()}`);
    const run = await processNextOutboxEvent(worker, { tenantId: f.tenantId, workerId: "f7-b", sink: answering({ outcome: "dead", code: "provider_rejected" }) });
    expect(run.kind).toBe("captured");
    expect((await owner<{ status: string }[]>`select status from data_requests where id = ${request.id}`)[0]!.status).toBe("completed");
    expect(await owner`select 1 from audit_events where tenant_id = ${f.tenantId} and action = 'privacy.erasure.notice_not_delivered'`).toHaveLength(1);
  });

  it("sends an export link on the second try when the first send needed a retry, and fails the request when it cannot be sent", async () => {
    const f = await createTenant(owner, "retry-export");
    const customer = await createCustomer(owner, f.tenantId);
    const account = await accountFor(customer.email);
    const { request } = await createPortalRequest(account, { clinicSlug: f.slug, patientId: customer.id, type: "export" });

    const first = await processNextOutboxEvent(worker, { tenantId: f.tenantId, workerId: "f7-c", sink: answering({ outcome: "retry", code: "provider_unavailable" }) });
    expect(first.kind).toBe("retry");
    expect((await owner<{ status: string }[]>`select status from data_requests where id = ${request.id}`)[0]!.status).toBe("processing");
    expect(await owner`select 1 from data_exports where tenant_id = ${f.tenantId}`).toHaveLength(1);

    const second = await runAgain(f.tenantId);
    expect(second.kind).toBe("captured");
    if (second.kind !== "captured") throw new Error("not captured");
    expect(await owner`select 1 from data_exports where tenant_id = ${f.tenantId}`).toHaveLength(1);
    const token = (JSON.parse(second.message.body) as { url: string }).url.split("/").at(-1)!;
    expect((await consumeExportDownload(token)).bytes.length).toBeGreaterThan(100);
    expect((await owner<{ status: string }[]>`select status from data_requests where id = ${request.id}`)[0]!.status).toBe("completed");

    // A send that is refused for good marks the request failed instead of completed.
    const other = await createCustomer(owner, f.tenantId);
    const otherAccount = await accountFor(other.email);
    const { request: refused } = await createPortalRequest(otherAccount, { clinicSlug: f.slug, patientId: other.id, type: "export" });
    const dead = await processNextOutboxEvent(worker, { tenantId: f.tenantId, workerId: "f7-d", sink: answering({ outcome: "dead", code: "provider_rejected" }) });
    expect(dead.kind).toBe("dead_letter");
    expect((await owner<{ status: string }[]>`select status from data_requests where id = ${refused.id}`)[0]!.status).toBe("failed");
  });

  it("moves a guardian's sealed contact to the newest key before the old key is retired", async () => {
    const f: TenantFixture = await createTenant(owner, "guardian-key");
    const child = await createCustomer(owner, f.tenantId, { dateOfBirth: new Date(Date.now() - 8 * 365.25 * 86_400_000).toISOString().slice(0, 10) });
    const account = await accountFor(child.email);
    await setPortalConsent(account, {
      clinicSlug: f.slug, patientId: child.id, purpose: "reviews", granted: true, wordingVersion: "2026-11",
      guardian: { name: "Meera Parent", relationship: "mother", contact: "meera.parent@example.com" },
    });
    const [before] = await owner<{ guardian_key_version: number; guardian_contact_ciphertext: string }[]>`select guardian_key_version, guardian_contact_ciphertext from patients where id = ${child.id}`;
    forgetDataKeys();
    const rotated = await worker.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${f.tenantId}, true)`;
      await loadDataKeys(postgresDataKeyStore(tx), f.tenantId);
      const version = await rotateTenantKey(tx, f.tenantId, "admin", "user-1");
      const moved = await reEncryptTenant(tx, f.tenantId);
      return { version, moved };
    });
    expect(rotated.version).toBeGreaterThan(before!.guardian_key_version);
    expect(rotated.moved).toBeGreaterThanOrEqual(1);
    const [after] = await owner<{ guardian_key_version: number; guardian_contact_ciphertext: string }[]>`select guardian_key_version, guardian_contact_ciphertext from patients where id = ${child.id}`;
    expect(after!.guardian_key_version).toBe(rotated.version);
    expect(after!.guardian_contact_ciphertext).not.toBe(before!.guardian_contact_ciphertext);
    await worker.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${f.tenantId}, true)`;
      await loadDataKeys(postgresDataKeyStore(tx), f.tenantId);
      expect(openSecret(f.tenantId, "patient.guardian-contact", after!.guardian_contact_ciphertext)).toBe("meera.parent@example.com");
    });
    // Nothing still uses the first key, so it may be retired now; it was not retired while the guardian's contact used it.
    const keys = await owner<{ version: number; retired_at: Date | null }[]>`select version, retired_at from tenant_data_keys where tenant_id = ${f.tenantId} order by version`;
    expect(keys.find((key) => key.version === before!.guardian_key_version)!.retired_at).not.toBeNull();
  });
});
