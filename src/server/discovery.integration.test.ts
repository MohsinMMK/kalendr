/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { planHasLapsed } from "@/lib/seo";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createTenant, setSubscription, staffContext, type TenantFixture } from "@/test/billing-fixture";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: <T,>(fn: T) => fn }));

import { loadDiscoveryState, searchDirectory, directoryFacets, resetDiscoveryCache, sitemapRows, sitemapFileCount } from "@/server/discovery";
import { loadListing, saveListing } from "@/server/listing";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeDb = isolatedDatabaseReady(runtimeUrl, ownerUrl) ? describe : describe.skip;

const DAY = 86_400_000;

describeDb("search and discovery: listing, sitemap and directory (feature 29)", () => {
  let owner: postgres.Sql;
  let runtime: postgres.Sql;
  let listed: TenantFixture;
  let unlisted: TenantFixture;
  let paused: TenantFixture;
  let off: TenantFixture;
  let lapsed: TenantFixture;
  let withDomain: TenantFixture;
  const word = `Zq${randomUUID().slice(0, 6)}`;

  const allRows = async () => {
    resetDiscoveryCache();
    const rows = [];
    for (let file = 0; file < (await sitemapFileCount()); file += 1) rows.push(...(await sitemapRows(file)));
    return rows;
  };
  const slugsInSitemap = async (): Promise<Set<string>> => {
    // The sitemap is kept for ten minutes in production; each read here starts fresh.
    resetDiscoveryCache();
    const slugs = new Set<string>();
    for (let file = 0; file < (await sitemapFileCount()); file += 1) for (const row of await sitemapRows(file)) slugs.add(row.slug);
    return slugs;
  };

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 4, prepare: false });
    runtime = postgres(runtimeUrl!, { max: 2, prepare: false });
    const make = async (label: string, name: string) => {
      const fixture = await createTenant(owner, label);
      await owner`update tenants set name = ${name}, about = ${`About ${name}`} where id = ${fixture.tenantId}`;
      await owner`update locations set city = 'Pune' where tenant_id = ${fixture.tenantId}`;
      await owner`update services set slug = ${`checkup-${label}`}, name = 'Check-up' where tenant_id = ${fixture.tenantId}`;
      await setSubscription(owner, fixture.tenantId, { status: "trialing", trialEndsAt: new Date(Date.now() + 5 * DAY) });
      return fixture;
    };
    listed = await make("disc-on", `${word} Dental Studio`);
    unlisted = await make("disc-off", `${word} Quiet Clinic`);
    paused = await make("disc-paused", `${word} Paused Clinic`);
    off = await make("disc-inactive", `${word} Closed Clinic`);
    lapsed = await make("disc-lapsed", `${word} Lapsed Clinic`);
    withDomain = await make("disc-domain", `${word} Own Domain Clinic`);
    for (const fixture of [listed, paused, off, lapsed, withDomain]) await owner`update tenants set listed = true where id = ${fixture.tenantId}`;
    await owner`update tenants set paused_at = now() where id = ${paused.tenantId}`;
    await owner`update tenants set is_active = false where id = ${off.tenantId}`;
    await setSubscription(owner, lapsed.tenantId, { status: "trialing", trialEndsAt: new Date(Date.now() - DAY) });
    await owner`insert into tenant_domains (tenant_id, hostname, status) values (${withDomain.tenantId}, ${`book-${word.toLowerCase()}.example.in`}, 'active')`;
    // One more service that must stay out of the sitemap, and a team member who has left.
    await owner`insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types, slug, visibility) values (${listed.tenantId}, 'Secret', 'x', 30, 'instant', ${["new"]}, 'secret', 'hidden')`;
    await owner`insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types, slug, is_active) values (${listed.tenantId}, 'Retired', 'x', 30, 'instant', ${["new"]}, 'retired', false)`;
    await owner`insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types, slug, kind) values (${listed.tenantId}, 'Yoga class', 'x', 30, 'instant', ${["new"]}, 'yoga-class', 'class')`;
    await owner`insert into practitioners (tenant_id, name, title, initials, specialty, is_active) values (${listed.tenantId}, 'Dr Gone', 'Doctor', 'DG', 'General', false)`;
  }, 60_000);
  afterAll(async () => { await owner?.end(); await runtime?.end(); });

  it("puts only listed, running businesses in the sitemap, with their service and team pages", async () => {
    const slugs = await slugsInSitemap();
    expect(slugs.has(listed.slug)).toBe(true);
    expect(slugs.has(withDomain.slug)).toBe(true);
    for (const hidden of [unlisted, paused, off, lapsed]) expect(slugs.has(hidden.slug), hidden.slug).toBe(false);
    const rows = (await allRows()).filter((row) => row.slug === listed.slug);
    expect(rows.filter((row) => row.kind === "business")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "service").map((row) => row.key)).toEqual([`checkup-disc-on`]);
    expect(rows.filter((row) => row.kind === "person").map((row) => row.key)).toEqual([listed.practitionerId]);
  });

  it("gives a business with a verified own address as its canonical address", async () => {
    const entry = (await allRows()).find((row) => row.slug === withDomain.slug && row.kind === "business");
    expect(entry?.domain).toBe(`book-${word.toLowerCase()}.example.in`);
    expect((await allRows()).find((row) => row.slug === listed.slug && row.kind === "business")?.domain).toBeNull();
  });

  it("splits into files and never returns more than a file holds", async () => {
    expect(await sitemapFileCount()).toBeGreaterThanOrEqual(1);
    const [row] = await runtime`select kalendr_sitemap_count() as total`;
    expect(Number(row!.total)).toBeGreaterThanOrEqual(3);
    const page = await runtime`select * from kalendr_sitemap_entries(0, 2)`;
    expect(page).toHaveLength(2);
  });

  it("lists the same businesses in the directory, and finds them by name, place and description", async () => {
    const byName = await searchDirectory({ q: word });
    const names = byName.cards.map((card) => card.name);
    expect(names).toContain(`${word} Dental Studio`);
    expect(names).toContain(`${word} Own Domain Clinic`);
    for (const hidden of ["Quiet Clinic", "Paused Clinic", "Closed Clinic", "Lapsed Clinic"]) expect(names.some((name) => name.endsWith(hidden)), hidden).toBe(false);
    const own = byName.cards.find((card) => card.name.endsWith("Own Domain Clinic"));
    expect(own?.url).toBe(`https://book-${word.toLowerCase()}.example.in/`);
    // Words narrow and rank: the business that matches every word comes first.
    expect((await searchDirectory({ q: `${word} dental`, city: "Pune" })).cards[0]?.name).toBe(`${word} Dental Studio`);
    expect((await searchDirectory({ q: word, city: "Nowhere" })).cards).toEqual([]);
    expect((await searchDirectory({ q: word, type: "dental" })).cards).toEqual([]);
    // A typo still finds it.
    expect((await searchDirectory({ q: `${word} Dentl Studio` })).cards.map((card) => card.name)).toContain(`${word} Dental Studio`);
  });

  it("offers cities and types only from listed businesses", async () => {
    const facets = await directoryFacets();
    expect(facets.cities.some((city) => city.value === "Pune")).toBe(true);
    expect(facets.types.length).toBeGreaterThan(0);
  });

  it("is safe with hostile directory text", async () => {
    for (const q of ["%", "_", "\\", "'; drop table tenants; --", "a & b | !c", ":*", "x".repeat(300)]) await expect(searchDirectory({ q })).resolves.toBeDefined();
    await expect(searchDirectory({ q: "ab", city: "%" })).resolves.toMatchObject({ cards: [] });
  });

  it("applies one rule for lapsed plans in the database and in the pages", async () => {
    const now = new Date();
    const cases = [
      { status: "trialing", trial: new Date(now.getTime() + DAY), due: null, end: null },
      { status: "trialing", trial: new Date(now.getTime() - DAY), due: null, end: null },
      { status: "active", trial: null, due: null, end: null },
      { status: "past_due", trial: null, due: new Date(now.getTime() - 3 * DAY), end: null },
      { status: "past_due", trial: null, due: new Date(now.getTime() - 9 * DAY), end: null },
      { status: "cancelled", trial: null, due: null, end: new Date(now.getTime() + DAY) },
      { status: "cancelled", trial: null, due: null, end: new Date(now.getTime() - DAY) },
      { status: "free", trial: null, due: null, end: null },
    ];
    for (const entry of cases) {
      const [row] = await owner<{ serves: boolean }[]>`select kalendr_subscription_serves(${entry.status}, ${entry.trial}, ${entry.due}, ${entry.end}) as serves`;
      expect(row!.serves, JSON.stringify(entry)).toBe(!planHasLapsed({ status: entry.status, trialEndsAt: entry.trial, pastDueSince: entry.due, currentPeriodEnd: entry.end }, now));
    }
  });

  it("tells a page whether it may be indexed", async () => {
    expect(await loadDiscoveryState(listed.slug)).toMatchObject({ listed: true, indexable: true, city: "Pune" });
    expect(await loadDiscoveryState(unlisted.slug)).toMatchObject({ listed: false, indexable: false });
    expect(await loadDiscoveryState(paused.slug)).toMatchObject({ listed: true, indexable: false });
    // A switched-off business has no public address at all, so there is nothing to describe.
    expect(await loadDiscoveryState(off.slug)).toBeNull();
    expect(await loadDiscoveryState(lapsed.slug)).toMatchObject({ listed: true, indexable: false });
    expect(await loadDiscoveryState(withDomain.slug)).toMatchObject({ customHost: `book-${word.toLowerCase()}.example.in` });
    expect(await loadDiscoveryState("no-such-business-anywhere")).toBeNull();
  });

  describe("at 100,000 listed businesses", () => {
    const prefix = `bigdisc${randomUUID().slice(0, 6)}`;
    beforeAll(async () => {
      await owner`
        insert into tenants (id, slug, name, legal_name, phone, email, timezone, business_type, about, listed)
        select ${prefix}::text || g, ${prefix}::text || '-' || g,
          (array['Smile','Lotus','Cedar','Riverbend','Aster','Nova','Prime','Calm'])[1 + g % 8] || ' ' || (array['Dental','Clinic','Studio','Salon','Physio','Care'])[1 + g % 6] || ' ' || g,
          'Legal ' || g, '+919800000000', ${prefix}::text || g || '@example.test', 'Asia/Kolkata', (array['healthcare','dental','wellness','education','other'])[1 + g % 5],
          'A friendly place number ' || g || ' with gentle care', true
        from generate_series(1, 100000) g`;
      await owner`insert into locations (tenant_id, name, address, city, timezone) select ${prefix}::text || g, 'Main', '1 Road', (array['Pune','Mumbai','Delhi','Bengaluru','Chennai'])[1 + g % 5], 'Asia/Kolkata' from generate_series(1, 100000) g`;
      await owner`insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types, slug) select ${prefix}::text || g, 'Check-up', 'x', 30, 'instant', ${["new"]}::text[], 'check-up' from generate_series(1, 100000) g`;
      await owner`analyze tenants`;
      await owner`analyze locations`;
      await owner`analyze services`;
    }, 240_000);
    afterAll(async () => {
      await owner`delete from tenants where id like ${`${prefix}%`}`;
      await owner`analyze tenants`;
    }, 120_000);

    const timed = async <T,>(label: string, limitMs: number, work: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      const result = await work();
      const took = performance.now() - started;
      expect(took, `${label} took ${Math.round(took)} ms`).toBeLessThan(limitMs);
      return result;
    };

    it("browses, searches and filters the directory in about a second or less", async () => {
      const first = await timed("browse", 1500, () => searchDirectory({}));
      expect(first.total).toBeGreaterThanOrEqual(100_000);
      expect(first.cards).toHaveLength(24);
      await timed("a deep page", 2500, () => searchDirectory({ page: 3000 }));
      expect((await timed("name search", 2500, () => searchDirectory({ q: "smile dental" }))).cards.length).toBeGreaterThan(0);
      expect((await timed("typo search", 2500, () => searchDirectory({ q: "Smile Dentl" }))).cards.length).toBeGreaterThan(0);
      expect((await timed("city and type", 1500, () => searchDirectory({ city: "Mumbai", type: "dental" }))).cards.length).toBeGreaterThan(0);
      resetDiscoveryCache();
      await timed("filters", 2500, () => directoryFacets());
    });

    it("serves a sitemap file of 10,000 pages in a couple of seconds, and the last file too", async () => {
      resetDiscoveryCache();
      const files = await timed("count", 2500, () => sitemapFileCount());
      expect(files).toBeGreaterThanOrEqual(20);
      expect((await timed("first file", 2500, () => sitemapRows(0))).length).toBe(10_000);
      expect((await timed("last file", 4000, () => sitemapRows(files - 1))).length).toBeGreaterThan(0);
      expect(await sitemapRows(files + 5)).toEqual([]);
    });
  });

  describe("the listing switch", () => {
    it("starts off, saves once, and says what the owner chose", async () => {
      const context = staffContext(unlisted, "owner");
      const before = await loadListing(context);
      expect(before).toMatchObject({ listed: false, indexable: false, seo: {} });
      expect(before.links.map((link) => link.id)).toEqual(["instagram", "whatsapp", "google", "email", "poster"]);
      const saved = await saveListing(context, { listed: true, seo: { title: "Quiet and kind", description: "A calm clinic." }, expected: { listed: false, seo: {} } });
      expect(saved).toMatchObject({ listed: true, indexable: true, seo: { title: "Quiet and kind", description: "A calm clinic." } });
      expect((await slugsInSitemap()).has(unlisted.slug)).toBe(true);
      await saveListing(context, { listed: false, seo: {}, expected: { listed: true, seo: { title: "Quiet and kind", description: "A calm clinic." } } });
      expect((await slugsInSitemap()).has(unlisted.slug)).toBe(false);
    });

    it("refuses a change made on top of a newer one", async () => {
      const context = staffContext(unlisted, "owner");
      await expect(saveListing(context, { listed: true, seo: {}, expected: { listed: true, seo: {} } })).rejects.toMatchObject({ code: "version_conflict", status: 409 });
    });

    it("keeps the owner's words out of the activity log", async () => {
      const context = staffContext(unlisted, "owner");
      const phrase = `Private words ${randomUUID()}`;
      await saveListing(context, { listed: false, seo: { title: phrase }, expected: { listed: false, seo: {} } });
      const rows = await owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where tenant_id = ${unlisted.tenantId} and action = 'settings.listing' order by occurred_at desc`;
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(phrase);
      expect(rows[0]!.metadata).toMatchObject({ titleSet: true });
      await saveListing(context, { listed: false, seo: {}, expected: { listed: false, seo: { title: phrase } } });
    });

    it("is for people who manage settings, and never for a read-only support session", async () => {
      await expect(saveListing(staffContext(unlisted, "receptionist"), { listed: true, seo: {}, expected: { listed: false, seo: {} } })).rejects.toMatchObject({ status: 403 });
      await expect(loadListing(staffContext(unlisted, "practitioner"))).rejects.toMatchObject({ status: 403 });
      const support = staffContext(unlisted, "owner", { impersonation: { sessionId: "s", businessName: "x", writeAccess: false, expiresAt: new Date(Date.now() + DAY).toISOString() } as never });
      await expect(saveListing(support, { listed: true, seo: {}, expected: { listed: false, seo: {} } })).rejects.toMatchObject({ code: "read_only_support_session" });
    });

    it("rejects over-long words and never touches another business", async () => {
      const context = staffContext(unlisted, "owner");
      await expect(saveListing(context, { listed: false, seo: { title: "t".repeat(200) }, expected: { listed: false, seo: {} } })).rejects.toThrow();
      const [other] = await owner<{ listed: boolean }[]>`select listed from tenants where id = ${listed.tenantId}`;
      expect(other!.listed).toBe(true);
    });

    it("explains why a listed business is still hidden", async () => {
      const view = await loadListing(staffContext(lapsed, "owner"));
      expect(view).toMatchObject({ listed: true, indexable: false });
      expect(view.blockers.join(" ")).toMatch(/plan has ended/);
    });
  });
});
