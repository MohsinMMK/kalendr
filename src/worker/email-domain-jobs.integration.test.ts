/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { emailDomainRecordName, emailDomainRecordValue } from "@/lib/email-domain-rules";
import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));

import { createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";
import { addDomain } from "@/server/enterprise/domains";
import type { DnsResolver } from "./domain-jobs";
import { sweepEmailDomains } from "./email-domain-jobs";

const describeLocal = isolatedDatabaseReady(process.env.DATABASE_URL, process.env.KALENDR_TEST_OWNER_URL, process.env.WORKER_DATABASE_URL) ? describe : describe.skip;

describeLocal("company email domain sweep", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    owner = postgres(process.env.KALENDR_TEST_OWNER_URL!, { max: 2, prepare: false });
    worker = postgres(process.env.WORKER_DATABASE_URL!, { max: 2, prepare: false });
    a = await createTenant(owner, "domaina");
    b = await createTenant(owner, "domainb");
  });

  afterAll(async () => {
    await owner`delete from tenants where id in (${a.tenantId}, ${b.tenantId})`.catch(() => undefined);
    await owner.end();
    await worker.end();
  });

  const resolverWith = (records: Record<string, string[] | null>): DnsResolver => ({ cname: async () => [], txt: async (name) => records[name] ?? [] });

  it("proves a domain once its record is published, only for the business whose token it carries", async () => {
    const domain = `sweep-${randomUUID().slice(0, 8)}.example`;
    const contextA = staffContext(a);
    const contextB = staffContext(b);
    const addedA = await addDomain(contextA, { domain });
    const addedB = await addDomain(contextB, { domain });
    const record = emailDomainRecordName(domain);

    const first = await sweepEmailDomains(worker, new Date(), resolverWith({}));
    expect(first.checked).toBeGreaterThanOrEqual(2);
    expect((await owner`select last_check_note from verified_domains where id = ${addedA.id}`)[0]!.last_check_note).toContain("can't see the record");

    // A's value is published: A is proved, B's claim on the same domain is not.
    const second = await sweepEmailDomains(worker, new Date(), resolverWith({ [record]: [addedA.dnsRecord!.value] }));
    expect(second.verified).toBe(1);
    expect((await owner`select verified_at from verified_domains where id = ${addedA.id}`)[0]!.verified_at).not.toBeNull();
    expect((await owner`select verified_at from verified_domains where id = ${addedB.id}`)[0]!.verified_at).toBeNull();
    expect((await owner`select count(*)::int as n from audit_events where tenant_id = ${a.tenantId} and action = 'enterprise.domain.verified'`)[0]!.n).toBe(1);

    // Even if B's own record shows up later, the domain already belongs to A.
    await sweepEmailDomains(worker, new Date(), resolverWith({ [record]: [addedB.dnsRecord!.value] }));
    expect((await owner`select verified_at, last_check_note from verified_domains where id = ${addedB.id}`)[0]).toMatchObject({ verified_at: null });
  });

  it("treats a failed lookup as 'try again', and stops looking after a week", async () => {
    const domain = `outage-${randomUUID().slice(0, 8)}.example`;
    const added = await addDomain(staffContext(a), { domain });
    const outage = await sweepEmailDomains(worker, new Date(), { cname: async () => null, txt: async () => null });
    expect(outage.failed).toBeGreaterThanOrEqual(1);
    expect((await owner`select verified_at, last_check_note from verified_domains where id = ${added.id}`)[0]!.verified_at).toBeNull();
    const later = await sweepEmailDomains(worker, new Date(Date.now() + 8 * 86_400_000), resolverWith({ [emailDomainRecordName(domain)]: [emailDomainRecordValue("anything")] }));
    expect(later.checked).toBe(0);
  });
});
