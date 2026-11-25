/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { tenantDomains } from "@/db/schema";
import { parseBrand } from "@/lib/brand-theme";
import { bookingFrameAncestors } from "@/lib/security-headers";
import { verifyRecordValue } from "@/lib/domain-rules";
import { ApiError } from "@/server/api-error";
import { effectiveBrand, loadPublicBrand, loadStaffBrand, saveBrand } from "@/server/brand";
import { loadEntitlements } from "@/server/entitlements";
import { createFakeEmailProvider } from "@/server/messaging/email-fake";
import { createEmailAdapter } from "@/worker/email-adapter";
import { providerSink } from "@/worker/delivery";
import { domainCheckHandler, sweepDomains, type DnsResolver } from "@/worker/domain-jobs";
import { createHandlers } from "@/worker/handlers";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { createTenant, isLocalDatabase, setSubscription, staffContext, type TenantFixture } from "@/test/billing-fixture";

import { addDomain, addEmbedOrigin, isServedDomain, listDomains, listEmbedOrigins, regenerateDomainToken, removeDomain, removeEmbedOrigin, requestDomainCheck } from "./service";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && isLocalDatabase(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const target = "edge.kalendr.test";
const run = randomUUID().slice(0, 8);

describeLocal("branding, own web address and embed sites (feature 13)", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let acme: TenantFixture;
  let rival: TenantFixture;
  const dns = { cname: [] as string[] | null, txt: [] as string[] | null };
  const resolver: DnsResolver = { cname: async () => dns.cname, txt: async () => dns.txt };
  const emails = createFakeEmailProvider();
  const handlers = createHandlers({
    sink: providerSink({ email: createEmailAdapter({ provider: emails, origin: "http://127.0.0.1:3202", fallbackReplyTo: null }) }),
    now: () => new Date(),
    origin: "http://127.0.0.1:3202",
  });

  beforeAll(async () => {
    process.env.KALENDR_CNAME_TARGET = target;
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 4, prepare: false });
    acme = await createTenant(owner, `acme${run}`);
    rival = await createTenant(owner, `rival${run}`);
    await setSubscription(owner, acme.tenantId, { plan: "growth", status: "active" });
    await setSubscription(owner, rival.tenantId, { plan: "growth", status: "active" });
  });
  afterAll(async () => {
    // Other suites share this database and some claim outbox rows from every business, so leave none of ours waiting.
    await owner`delete from outbox_events where tenant_id in (${acme.tenantId}, ${rival.tenantId})`.catch(() => undefined);
    delete process.env.KALENDR_CNAME_TARGET;
    await Promise.all([owner.end(), worker.end()]);
  });
  beforeEach(async () => {
    // The plan allows three addresses at once, so each test starts from none.
    await owner`delete from tenant_domains where tenant_id in (${acme.tenantId}, ${rival.tenantId})`;
    dns.cname = [];
    dns.txt = [];
    emails.reset();
  });

  const hostFor = (label: string) => `${label}-${run}.acme-clinic.org`;
  const staffFor = (fixture: TenantFixture) => staffContext(fixture);

  describe("branding", () => {
    it("saves the look, tells the owner about readable text, and refuses the badge switch on a plan without it", async () => {
      const context = staffFor(acme);
      await setSubscription(owner, acme.tenantId, { plan: "starter", status: "active" });
      await expect(saveBrand(context, { accent: "#f5b800", corners: "round", hideBadge: true })).rejects.toMatchObject({ status: 402, code: "plan_limit" });
      const saved = await saveBrand(context, { accent: "#f5b800", corners: "round", hideBadge: false });
      expect(saved.settings).toEqual({ accent: "#f5b800", corners: "round", hideBadge: false });
      expect(saved.notes.join(" ")).toMatch(/dark text/);
      expect((await loadStaffBrand(context)).settings.accent).toBe("#f5b800");
    });

    it("lets a plan with the feature hide the badge, and shows it again when the plan lapses", async () => {
      const context = staffFor(acme);
      await setSubscription(owner, acme.tenantId, { plan: "growth", status: "active" });
      await saveBrand(context, { accent: "#0f766e", corners: "soft", hideBadge: true });
      expect((await loadPublicBrand(acme.tenantId))?.hideBadge).toBe(true);
      // The stored flag stays, but a lapsed plan no longer honours it.
      await setSubscription(owner, acme.tenantId, { plan: "free", status: "free" });
      expect((await loadPublicBrand(acme.tenantId))?.hideBadge).toBe(false);
      const { entitlements } = await loadEntitlements(acme.tenantId);
      expect(effectiveBrand({ hideBadge: true }, entitlements).hideBadge).toBe(false);
      await setSubscription(owner, acme.tenantId, { plan: "growth", status: "active" });
    });

    it("refuses a bad accent and keeps the read-only support guard", async () => {
      const context = staffFor(acme);
      await expect(saveBrand(context, { accent: "red; background:url(x)", corners: "soft", hideBadge: false })).rejects.toThrow();
      const supportView = staffContext(acme, "owner", { impersonation: { operatorName: "Support", writeAccess: false } as never });
      await expect(saveBrand(supportView, { accent: "#0f766e", corners: "soft", hideBadge: false })).rejects.toMatchObject({ code: "read_only_support_session" });
    });

    it("stores nothing but parsed values", async () => {
      const [row] = await owner<{ brand: unknown }[]>`select brand from tenants where id = ${acme.tenantId}`;
      expect(parseBrand(row?.brand)).toEqual(row?.brand);
    });

    it("keeps one business's look away from another", async () => {
      await saveBrand(staffFor(rival), { accent: "#4f46e5", corners: "square", hideBadge: false });
      expect((await loadPublicBrand(acme.tenantId))?.accent).not.toBe("#4f46e5");
      expect((await loadPublicBrand(rival.tenantId))?.accent).toBe("#4f46e5");
    });

    it("sends an email in the business's colour with dark text on a light accent, and drops the badge line when hidden", async () => {
      await saveBrand(staffFor(acme), { accent: "#f5b800", corners: "soft", hideBadge: true });
      await owner`insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
        values (${acme.tenantId}, 'domain', ${randomUUID()}, 'domain.notice', ${owner.json({ kind: "domain_records_missing", hostname: "book.acme.test" })}, ${`mail:${run}`})`;
      await drainTenantOutbox(worker, acme.tenantId, handlers);
      const message = emails.sent.at(-1);
      expect(message?.subject).toContain("book.acme.test");
      expect(message?.html).toContain("#f5b800");
      expect(message?.html).toMatch(/color:#000000/);
      expect(message?.html).not.toContain("using Kalendr");
    });
  });

  describe("own web address", () => {
    it("is refused on a plan without it, and when the deployment has no target", async () => {
      await setSubscription(owner, rival.tenantId, { plan: "starter", status: "active" });
      await expect(addDomain(staffFor(rival), hostFor("nope"))).rejects.toMatchObject({ status: 402, code: "plan_limit" });
      await setSubscription(owner, rival.tenantId, { plan: "growth", status: "active" });
      delete process.env.KALENDR_CNAME_TARGET;
      await expect(addDomain(staffFor(rival), hostFor("nope"))).rejects.toMatchObject({ code: "domains_not_configured" });
      process.env.KALENDR_CNAME_TARGET = target;
    });

    it("rejects addresses it cannot serve", async () => {
      for (const bad of ["acme-clinic.test", "localhost", "https://edge.kalendr.test", "a.b"]) {
        await expect(addDomain(staffFor(acme), bad), bad).rejects.toMatchObject({ code: "validation_error" });
      }
    });

    it("goes live only when both records are found, a refused address gets no certificate, and the TXT value is stored only as a hash", async () => {
      const context = staffFor(acme);
      const hostname = hostFor("live");
      const created = await addDomain(context, hostname);
      expect(created.domain.state).toBe("pending");
      expect(created.domain.records).toEqual({ cname: { name: hostname, value: target }, txt: { name: `_kalendr-verify.${hostname}` } });
      expect(created.txtValue).toMatch(/^kalendr-verify=[0-9a-f]{64}$/);
      const [row] = await owner<{ verification_token_hash: string }[]>`select verification_token_hash from tenant_domains where id = ${created.domain.id}`;
      expect(row?.verification_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(created.txtValue).not.toContain(row!.verification_token_hash);

      // Not yet: no certificate and no routing.
      expect(await isServedDomain(hostname)).toBe(false);
      expect((await worker`select * from kalendr_domain_tenants() as t`).some((entry) => entry.t === acme.tenantId)).toBe(true);
      await sweepDomains(worker, new Date(), resolver);
      expect((await listDomains(context)).domains.find((domain) => domain.id === created.domain.id)?.state).toBe("pending");
      expect(await isServedDomain(hostname)).toBe(false);

      // Only the CNAME: still not live.
      dns.cname = [`${target}.`];
      await owner`update tenant_domains set last_checked_at = null where id = ${created.domain.id}`;
      await sweepDomains(worker, new Date(), resolver);
      expect(await isServedDomain(hostname)).toBe(false);

      // Both records: live.
      dns.txt = [verifyRecordValue(created.txtValue.slice("kalendr-verify=".length))];
      await owner`update tenant_domains set last_checked_at = null where id = ${created.domain.id}`;
      const summary = await sweepDomains(worker, new Date(), resolver);
      expect(summary.wentLive).toBeGreaterThanOrEqual(1);
      expect(await isServedDomain(hostname)).toBe(true);
      expect(await isServedDomain(`other.${hostname}`)).toBe(false);
      const [lookup] = await owner<{ tenant_id: string; slug: string }[]>`select * from kalendr_domain_lookup(${hostname.toUpperCase()})`;
      expect(lookup).toEqual({ tenant_id: acme.tenantId, slug: acme.slug });
      expect((await listDomains(context)).domains.find((domain) => domain.id === created.domain.id)).toMatchObject({ state: "live" });
    });

    it("answers Check now through the worker, not the request", async () => {
      const context = staffFor(acme);
      const created = await addDomain(context, hostFor("now"));
      expect(await requestDomainCheck(context, created.domain.id)).toEqual({ queued: true });
      // Pressing again inside the same minute queues no second lookup.
      await requestDomainCheck(context, created.domain.id);
      const queued = await owner`select id from outbox_events where tenant_id = ${acme.tenantId} and event_type = 'domain.check' and aggregate_id = ${created.domain.id}`;
      expect(queued).toHaveLength(1);
      // The worker takes the queued row and looks the records up with its own resolver.
      dns.cname = [target];
      dns.txt = [created.txtValue];
      const handler = domainCheckHandler({ now: () => new Date() }, resolver);
      const outcome = await worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${acme.tenantId}, true)`;
        return handler(tenantDb, { id: queued[0]!.id as string, tenantId: acme.tenantId, aggregateType: "domain", aggregateId: created.domain.id, eventType: "domain.check", payload: { domainId: created.domain.id }, dedupeKey: "x", attemptCount: 1 });
      });
      expect(outcome).toBe("delivered");
      expect(await isServedDomain(hostFor("now"))).toBe(true);
    });

    it("keeps a claim another business made on an address from blocking the rightful owner once it lapses", async () => {
      const hostname = hostFor("contested");
      await addDomain(staffFor(acme), hostname);
      await expect(addDomain(staffFor(rival), hostname)).rejects.toMatchObject({ code: "domain_taken" });
      // The first claim never verified and its 72 hours are over.
      await owner`update tenant_domains set check_until = now() - interval '1 hour' where hostname = ${hostname}`;
      const claimed = await addDomain(staffFor(rival), hostname);
      expect(claimed.domain.hostname).toBe(hostname);
      expect((await listDomains(staffFor(acme))).domains.some((domain) => domain.hostname === hostname)).toBe(false);
    });

    it("never lets a live address be taken over", async () => {
      const hostname = hostFor("keep");
      const created = await addDomain(staffFor(acme), hostname);
      await owner`update tenant_domains set status = 'active', verified_at = now(), check_until = now() - interval '1 hour' where id = ${created.domain.id}`;
      await expect(addDomain(staffFor(rival), hostname)).rejects.toMatchObject({ code: "domain_taken" });
      expect(await isServedDomain(hostname)).toBe(true);
    });

    it("warns once when records disappear, keeps serving for 7 days, then stops and says so", async () => {
      const context = staffFor(acme);
      const hostname = hostFor("fading");
      const created = await addDomain(context, hostname);
      dns.cname = [target];
      dns.txt = [created.txtValue];
      await sweepDomains(worker, new Date(), resolver);
      expect(await isServedDomain(hostname)).toBe(true);

      // A failed lookup is not a missing record.
      dns.cname = null;
      await owner`update tenant_domains set last_checked_at = now() - interval '2 days' where id = ${created.domain.id}`;
      await sweepDomains(worker, new Date(), resolver);
      expect((await listDomains(context)).domains.find((domain) => domain.id === created.domain.id)?.state).toBe("live");

      // The records are gone.
      dns.cname = [];
      dns.txt = [];
      await owner`update tenant_domains set last_checked_at = now() - interval '2 days' where id = ${created.domain.id}`;
      await sweepDomains(worker, new Date(), resolver);
      expect((await listDomains(context)).domains.find((domain) => domain.id === created.domain.id)?.state).toBe("warning");
      expect(await isServedDomain(hostname)).toBe(true);
      await owner`update tenant_domains set last_checked_at = now() - interval '2 days' where id = ${created.domain.id}`;
      await sweepDomains(worker, new Date(), resolver);
      const warnings = await owner`select id from outbox_events where tenant_id = ${acme.tenantId} and event_type = 'domain.notice' and payload->>'hostname' = ${hostname}`;
      expect(warnings).toHaveLength(1);

      // Seven days on.
      await owner`update tenant_domains set last_checked_at = now() - interval '2 days', missing_since = now() - interval '8 days' where id = ${created.domain.id}`;
      expect(await isServedDomain(hostname)).toBe(false);
      await sweepDomains(worker, new Date(), resolver);
      expect((await listDomains(context)).domains.find((domain) => domain.id === created.domain.id)?.state).toBe("failed");
      const notices = await owner<{ payload: { kind: string } }[]>`select payload from outbox_events where tenant_id = ${acme.tenantId} and event_type = 'domain.notice' and payload->>'hostname' = ${hostname}`;
      expect(notices.map((notice) => notice.payload.kind).sort()).toEqual(["domain_records_missing", "domain_stopped"]);

      await drainTenantOutbox(worker, acme.tenantId, handlers);
      expect(emails.sent.some((message) => message.subject.includes("switched off"))).toBe(true);
    });

    it("gives up after 72 hours and lets the owner start again with a new TXT value", async () => {
      const context = staffFor(acme);
      const created = await addDomain(context, hostFor("late"));
      await owner`update tenant_domains set check_until = now() - interval '1 hour', last_checked_at = now() - interval '1 hour' where id = ${created.domain.id}`;
      await sweepDomains(worker, new Date(), resolver);
      expect((await listDomains(context)).domains.find((domain) => domain.id === created.domain.id)?.state).toBe("failed");
      const again = await regenerateDomainToken(context, created.domain.id);
      expect(again.txtValue).not.toBe(created.txtValue);
      expect(again.domain.state).toBe("pending");
    });

    it("keeps one business's addresses private, removes an address at once, and audits changes without free text", async () => {
      const hostname = hostFor("private");
      const created = await addDomain(staffFor(acme), hostname);
      expect((await listDomains(staffFor(rival))).domains.map((domain) => domain.hostname)).not.toContain(hostname);
      await expect(removeDomain(staffFor(rival), created.domain.id)).rejects.toMatchObject({ status: 404 });
      await expect(requestDomainCheck(staffFor(rival), created.domain.id)).rejects.toBeInstanceOf(ApiError);
      const direct = await withTenant(rival.tenantId, (transaction) => transaction.select().from(tenantDomains));
      expect(direct.some((row) => row.hostname === hostname)).toBe(false);
      await removeDomain(staffFor(acme), created.domain.id);
      expect(await isServedDomain(hostname)).toBe(false);
      const [audit] = await owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where tenant_id = ${acme.tenantId} and action = 'domain.removed' order by occurred_at desc limit 1`;
      expect(Object.keys(audit!.metadata)).toEqual(["hostname"]);
    });

    it("keeps the read-only support guard on every write", async () => {
      const supportView = staffContext(acme, "owner", { impersonation: { operatorName: "Support", writeAccess: false } as never });
      await expect(addDomain(supportView, hostFor("support"))).rejects.toMatchObject({ code: "read_only_support_session" });
      await expect(addEmbedOrigin(supportView, "https://www.acme-clinic.test")).rejects.toMatchObject({ code: "read_only_support_session" });
    });
  });

  describe("embed sites", () => {
    it("saves, lists and removes sites, and feeds only those into frame-ancestors", async () => {
      const context = staffFor(acme);
      const saved = await addEmbedOrigin(context, "WWW.Acme-Clinic.test/contact?x=1");
      expect(saved.origin).toBe("https://www.acme-clinic.test");
      expect((await addEmbedOrigin(context, "https://www.acme-clinic.test")).id).toBe(saved.id);
      expect((await listEmbedOrigins(context)).map((entry) => entry.origin)).toEqual(["https://www.acme-clinic.test"]);
      const fromFunction = await owner<{ origin: string }[]>`select kalendr_embed_origins as origin from kalendr_embed_origins(${acme.slug})`;
      expect(fromFunction.map((row) => row.origin)).toEqual(["https://www.acme-clinic.test"]);
      expect(bookingFrameAncestors(fromFunction.map((row) => row.origin))).toContain("https://www.acme-clinic.test");
      // Another business's page is not framed by this site.
      const rivalOrigins = await owner<{ origin: string }[]>`select kalendr_embed_origins as origin from kalendr_embed_origins(${rival.slug})`;
      expect(rivalOrigins).toEqual([]);
      expect(bookingFrameAncestors(rivalOrigins.map((row) => row.origin))).not.toContain("acme-clinic");
      await removeEmbedOrigin(context, saved.id);
      expect(await listEmbedOrigins(context)).toEqual([]);
    });

    it("refuses anything that is not a plain https site, in code and in the database", async () => {
      for (const bad of ["http://acme-clinic.test", "https://a.test; script-src *", "javascript:alert(1)"]) {
        await expect(addEmbedOrigin(staffFor(acme), bad), bad).rejects.toMatchObject({ code: "validation_error" });
      }
      await expect(owner`insert into tenant_embed_origins (tenant_id, origin) values (${acme.tenantId}, 'https://x.test; evil')`).rejects.toThrow();
      await expect(owner`insert into tenant_embed_origins (tenant_id, origin) values (${acme.tenantId}, 'http://x.test')`).rejects.toThrow();
    });

    it("hides one business's sites from another, row by row", async () => {
      await addEmbedOrigin(staffFor(acme), "https://private.acme-clinic.test");
      expect(await listEmbedOrigins(staffFor(rival))).toEqual([]);
      const rows = await withTenant(rival.tenantId, (transaction) => transaction.execute(sql`select origin from tenant_embed_origins`));
      expect(rows).toHaveLength(0);
    });
  });
});
