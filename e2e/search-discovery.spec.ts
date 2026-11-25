import { expect, test, type Page } from "@playwright/test";

import { expectAccessible, signIn, unique, withOwnerDatabase } from "./support/journey";

const owner = "kalendr.owner@example.com";
const slug = "lotus-dental";
const quiet = "riverbend-care";
const third = "cedar-hair";

async function setListing(slugs: string[], listed: boolean): Promise<void> {
  await withOwnerDatabase(async (sql) => {
    await sql`update tenants set listed = ${listed}, seo = '{}'::jsonb where slug in ${sql(slugs)}`;
  });
}

async function metaContent(page: Page, selector: string): Promise<string | null> {
  return page.locator(selector).first().getAttribute("content");
}

test.afterAll(async () => { await setListing([slug, quiet, third], false); });

test("the palette finds customers, appointments, services and team members, and opens them", async ({ page }, testInfo) => {
  const word = `Palette${unique().replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;
  let serviceName = "";
  await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    await sql`insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel) values (${tenant!.id}, ${word}, 'Finder', '+919811100099', ${`${word}@example.com`.toLowerCase()}, 'email')`;
    const [service] = await sql<{ name: string }[]>`select name from services where tenant_id = ${tenant!.id} and is_active order by name limit 1`;
    serviceName = service!.name;
  });
  await signIn(page, owner, undefined, "/dashboard");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // A customer, found from part of the name.
  await dialog.getByRole("combobox").fill(word.slice(0, 12));
  await expect(dialog.getByRole("option", { name: new RegExp(`^${word} Finder ·`) })).toBeVisible();

  // A service, from the first word of its name: the palette opens a new booking for it.
  await dialog.getByRole("combobox").fill(serviceName.split(" ")[0]!);
  const service = dialog.getByRole("option", { name: new RegExp(`^${serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
  await expect(service.first()).toBeVisible();
  await expectAccessible(page, testInfo, "palette with search results", '[role="dialog"]');
  await service.first().click();
  await expect(page).toHaveURL(/\/appointments\/new\?service=/);

  // Typing symbols or one letter never errors: the palette just says nothing was found.
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").getByRole("combobox").fill("%%");
  await expect(page.getByRole("dialog").getByText(/Nothing found/)).toBeVisible();
});

test("an owner lists the business, and search engines see it; switching it off hides it again", async ({ page, request }, testInfo) => {
  await setListing([slug, quiet, third], false);
  // Unlisted: not in the sitemap, and the page says noindex.
  const before = await request.get("/sitemap/0.xml");
  expect(before.ok()).toBe(true);
  expect(await before.text()).not.toContain(`/b/${slug}`);
  await page.goto(`/b/${slug}`);
  expect(await metaContent(page, 'meta[name="robots"]')).toMatch(/noindex/);

  await signIn(page, owner, undefined, "/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Find and share" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Find and share" })).toBeVisible();
  await expect(page.getByText("Hidden from search engines")).toBeVisible();
  await page.getByRole("switch", { name: /find us on Google/ }).click();
  await page.getByLabel("Page title").fill("Lotus Dental, the gentle dentist");
  await page.getByLabel("Page description").fill("Painless dentistry in New Delhi. Book online in a minute.");
  await expectAccessible(page, testInfo, "find and share settings", "#clinic-main");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Visible to search engines")).toBeVisible();

  // The page now describes itself with the owner's words, calls itself indexable and carries valid structured data.
  await page.goto(`/b/${slug}`);
  expect(await metaContent(page, 'meta[name="robots"]')).toMatch(/index/);
  expect(await metaContent(page, 'meta[name="robots"]')).not.toMatch(/noindex/);
  await expect(page).toHaveTitle("Lotus Dental, the gentle dentist");
  expect(await metaContent(page, 'meta[name="description"]')).toBe("Painless dentistry in New Delhi. Book online in a minute.");
  expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toMatch(new RegExp(`/b/${slug}$`));
  expect(await metaContent(page, 'meta[property="og:image"]')).toContain(`/b/${slug}/opengraph-image`);
  const markup = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent()) ?? "{}") as Record<string, unknown>;
  expect(markup).toMatchObject({ "@context": "https://schema.org", "@type": "Dentist", name: "Lotus Dental Studio" });
  expect(markup).toHaveProperty("makesOffer");
  // No reviews are published for this business, so no rating is claimed.
  expect(markup).not.toHaveProperty("aggregateRating");

  // The sitemap lists it with its service and team pages; the unlisted businesses are still out.
  const after = await (await request.get("/sitemap/0.xml")).text();
  expect(after).toContain(`/b/${slug}</loc>`);
  expect(after).toMatch(new RegExp(`/book/${slug}/[a-z0-9-]+</loc>`));
  expect(after).toMatch(new RegExp(`/b/${slug}/team/[0-9a-f-]+</loc>`));
  expect(after).not.toContain(`/b/${quiet}`);
  // A file number past the last one is served empty, never an error.
  expect((await request.get("/sitemap/42.xml")).status()).toBeLessThan(500);
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("/sitemap/0.xml");
  expect(robots).toMatch(/Disallow: \/manage\//);

  // The unlisted business next door still says noindex, and so does the booking flow.
  await page.goto(`/b/${quiet}`);
  expect(await metaContent(page, 'meta[name="robots"]')).toMatch(/noindex/);
  await page.goto(`/book/${slug}`);
  expect(await metaContent(page, 'meta[name="robots"]')).toMatch(/noindex/);

  // Switching listing off takes it back out.
  await setListing([slug], false);
  expect(await (await request.get("/sitemap/0.xml")).text()).not.toContain(`/b/${slug}`);
  await page.goto(`/b/${slug}`);
  expect(await metaContent(page, 'meta[name="robots"]')).toMatch(/noindex/);
});

test("the link preview picture is a real image, and a business named </script> renders safely", async ({ page, request }) => {
  const image = await request.get(`/b/${slug}/opengraph-image`);
  expect(image.ok()).toBe(true);
  expect(image.headers()["content-type"]).toContain("image/png");
  expect((await image.body()).byteLength).toBeGreaterThan(2_000);

  const hostile = "</script><script>window.__injected=1</script>";
  const original = await withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ name: string }[]>`select name from tenants where slug = ${third}`;
    await sql`update tenants set name = ${hostile}, listed = true where slug = ${third}`;
    return row!.name;
  });
  try {
    await page.goto(`/b/${third}`);
    expect(await page.evaluate(() => (window as unknown as { __injected?: number }).__injected)).toBeUndefined();
    const markup = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent()) ?? "{}") as { name?: string };
    expect(markup.name).toBe(hostile);
    expect(await page.content()).not.toContain("<script>window.__injected");
    expect((await request.get(`/b/${third}/opengraph-image`)).ok()).toBe(true);
  } finally {
    await withOwnerDatabase(async (sql) => { await sql`update tenants set name = ${original}, listed = false where slug = ${third}`; });
  }
});

test("the directory shows only listed businesses, filters by city and finds them by name", async ({ page }, testInfo) => {
  await setListing([slug, quiet, third], false);
  await setListing([slug], true);
  await page.goto("/explore");
  await expect(page.getByRole("heading", { level: 1, name: "Find a business to book" })).toBeVisible();
  const list = page.getByRole("list").filter({ has: page.getByRole("heading", { level: 2 }) });
  await expect(list.getByRole("link", { name: "Lotus Dental Studio" })).toBeVisible();
  await expect(page.getByText("Riverbend Family Clinic")).toHaveCount(0);
  expect(await metaContent(page, 'meta[name="robots"]')).toMatch(/index/);
  await expectAccessible(page, testInfo, "directory");

  await page.getByRole("searchbox").fill("lotus dentl");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/q=lotus\+dentl|q=lotus%20dentl/);
  await expect(page.getByRole("link", { name: "Lotus Dental Studio" })).toBeVisible();
  expect(await metaContent(page, 'meta[name="robots"]')).toMatch(/noindex/);

  await page.goto("/explore?city=Nowhere");
  await expect(page.getByText("No business matches that")).toBeVisible();
  await page.getByRole("link", { name: "Clear search" }).click();
  await page.getByRole("link", { name: "Lotus Dental Studio" }).click();
  await expect(page).toHaveURL(new RegExp(`/b/${slug}`));
});

test("the poster prints on A4 and A5 with a code that opens the booking page with a source tag", async ({ page }, testInfo) => {
  await signIn(page, owner, undefined, "/print/poster?size=a4");
  const poster = page.getByRole("article", { name: /Poster for Lotus Dental Studio/ });
  await expect(poster).toBeVisible();
  await expect(poster.getByRole("img", { name: /QR code that opens the booking page/ })).toBeVisible();
  await expect(poster).toContainText(`/b/${slug}`);
  expect(await page.evaluate(() => document.querySelector("style")?.textContent ?? "")).toContain("size: A4");
  await expectAccessible(page, testInfo, "poster");
  // On paper: the controls are gone and the sheet fills exactly one page of the chosen size.
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("button", { name: "Print" })).toBeHidden();
  const a4 = (await page.pdf({ preferCSSPageSize: true })).toString("latin1");
  expect(a4.match(/\/Type\s*\/Page(?![a-z])/g)).toHaveLength(1);
  expect(a4).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+59[45]\.\d+\s+84[12]\.\d+\s*\]/);
  await page.emulateMedia({ media: "screen" });
  await page.goto("/print/poster?size=a5");
  expect(await page.evaluate(() => Array.from(document.querySelectorAll("style")).map((style) => style.textContent).join(""))).toContain("size: A5");
  await page.emulateMedia({ media: "print" });
  const a5 = (await page.pdf({ preferCSSPageSize: true })).toString("latin1");
  expect(a5.match(/\/Type\s*\/Page(?![a-z])/g)).toHaveLength(1);
  expect(a5).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+4(?:19|20)(?:\.\d+)?\s+59[45](?:\.\d+)?\s*\]/);
  await page.emulateMedia({ media: "screen" });

  // The share kit hands out the same link for the poster, tagged with its source.
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Find and share" }).click();
  await page.getByRole("combobox", { name: "Where will you share it?" }).click();
  await page.getByRole("option", { name: "Poster QR code" }).click();
  const link = await page.getByRole("textbox", { name: "Poster QR code link" }).inputValue();
  expect(new URL(link).pathname).toBe(`/book/${slug}`);
  expect(new URL(link).searchParams.get("utm_source")).toBe("poster");
  // And that link opens the booking page.
  await page.goto(link);
  await expect(page).toHaveURL(new RegExp(`/book/${slug}\\?utm_source=poster`));
});
