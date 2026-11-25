import { expect, test } from "@playwright/test";

import { chooseCard, expectAccessible, fillCustomerDetails, newCustomer, signIn, unique, withOwnerDatabase } from "./support/journey";

/**
 * Feature 13: the owner picks a yellow accent and the booking page shows dark text on it, a business's own address
 * serves its pages while an unknown host gets a plain 404 and staff sign-in is not reachable there, an address
 * that is not verified is refused a certificate, and the booking widget can be framed only by a saved site.
 *
 * What these tests cannot prove: a real certificate (needs the hosting provider) and a real DNS lookup (the worker is
 * covered with a fake resolver in src/server/domains/identity.integration.test.ts). The "address went live" step is
 * done in the database here, the way the worker does it.
 */
const owner = "kalendr.owner@example.com";
const slug = "lotus-dental";
const app = process.env.KALENDR_APP_URL ?? "http://localhost:3100";
const port = new URL(app).port;

// The fake "customer website" below is https and frames this app over http on localhost, which Chrome would otherwise block (mixed content, and its public-to-local network check).
test.use({ launchOptions: { args: ["--allow-running-insecure-content", "--disable-features=HttpsUpgrades,AutoupgradeMixedContent,LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations,BlockInsecurePrivateNetworkRequests"] } });

test("an owner picks a yellow accent, sees dark text on it in the preview and on the booking page", async ({ page }, testInfo) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 152 : 52}` });
  await withOwnerDatabase(async (sql) => {
    await sql`update tenants set brand = '{}'::jsonb where slug = ${slug}`;
  });
  await signIn(page, owner, undefined, "/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Logo, cover and colours" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Logo, cover and colours" })).toBeVisible();

  await page.getByRole("button", { name: "Use #f5b800" }).click();
  await expect(page.getByRole("status").filter({ hasText: "buttons use dark text" })).toBeVisible();
  const preview = page.getByRole("img", { name: /Preview on/ });
  await expect(preview).toHaveCSS("--primary-foreground", "#000000");
  await expectAccessible(page, testInfo, "branding settings", "#clinic-main");
  await page.getByRole("button", { name: "Save branding" }).click();
  await expect(page.getByText("Branding saved")).toBeVisible();

  // Customers see it. Reload so nothing is read from this page's state.
  await page.goto(`/b/${slug}`);
  const shell = page.locator("div.min-h-screen").first();
  await expect(shell).toHaveCSS("--primary", "#f5b800");
  await expect(shell).toHaveCSS("--primary-foreground", "#000000");
  const book = page.getByRole("link", { name: /book/i }).first();
  await expect(book).toBeVisible();
  // The staff screens keep Kalendr's own colours.
  await page.goto("/settings");
  await expect(page.locator("body")).not.toHaveCSS("--primary", "#f5b800");
});

test("a business's own address serves its pages, refuses staff pages and unknown hosts, and an unverified address gets no certificate", async ({ page, request }, testInfo) => {
  const hostname = `book-${unique().slice(0, 8)}.localhost`;
  const own = `http://${hostname}:${port}`;
  let tenantId = "";
  await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    tenantId = tenant!.id;
    await sql`insert into tenant_domains (tenant_id, hostname, status, check_until) values (${tenantId}, ${hostname}, 'pending', now() + interval '3 days')`;
  });
  const check = (domain: string) => request.get(`${app}/api/internal/domain-check?domain=${encodeURIComponent(domain)}`, { headers: { "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 163 : 63}` } });

  // Not verified yet: no certificate, and a pending address is refused like any unknown host. (A different pending
  // host is used for the page request, because the proxy remembers a refusal for a few seconds.)
  expect((await check(hostname)).status()).toBe(404);
  const pending = `pending-${unique().slice(0, 8)}.localhost`;
  await withOwnerDatabase(async (sql) => {
    await sql`insert into tenant_domains (tenant_id, hostname, status, check_until) values (${tenantId}, ${pending}, 'pending', now() + interval '3 days')`;
  });
  expect((await request.get(`http://${pending}:${port}/`)).status()).toBe(404);

  // The worker's step: both records found, so the address goes live.
  await withOwnerDatabase(async (sql) => {
    await sql`update tenant_domains set status = 'active', verified_at = now(), last_result = 'ok' where hostname = ${hostname}`;
  });
  expect((await check(hostname)).status()).toBe(200);
  expect((await check("random.example.org")).status()).toBe(404);

  // Its own address shows the business page and the booking flow, not Kalendr's staff screens.
  await page.goto(`${own}/`);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expect(page).toHaveURL(`${own}/`);
  await page.goto(`${own}/book`);
  await expect(page.getByRole("main")).toBeVisible();
  // A customer can book end to end on the business's own address: the holds and bookings calls work there too, and so does the manage link.
  const customer = newCustomer("Own");
  await chooseCard(page, "Dental consultation");
  await chooseCard(page, "Dr Kavya Rao");
  await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
  await page.getByRole("radiogroup").last().getByRole("radio").first().click();
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible({ timeout: 20_000 });
  const manage = await page.getByRole("link", { name: "Manage appointment" }).getAttribute("href");
  expect(manage).toMatch(/^\/manage\//);
  await page.goto(`${own}${manage}`);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  for (const path of ["/sign-in", "/dashboard", "/settings", "/api/staff/snapshot", "/api/auth/get-session", `/b/some-other-business`]) {
    expect((await request.get(`${own}${path}`)).status(), path).toBe(404);
  }
  // A host nobody owns gets a plain 404 with nothing about Kalendr in it.
  const unknown = await request.get(`http://nobody-${unique().slice(0, 6)}.localhost:${port}/`);
  expect(unknown.status()).toBe(404);
  expect(await unknown.text()).toBe("Not found");

  // Removing the address stops it at once (the proxy forgets within a minute at most; a fresh server process forgets now).
  await withOwnerDatabase(async (sql) => {
    await sql`delete from tenant_domains where hostname in (${hostname}, ${pending})`;
  });
  expect((await check(hostname)).status()).toBe(404);
});

test("the booking page can be framed by a saved site and by no other", async ({ page, request }, testInfo) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 154 : 54}` });
  const site = `https://widget-${unique().slice(0, 6)}.example.org`;
  await withOwnerDatabase(async (sql) => {
    await sql`delete from tenant_embed_origins where tenant_id = (select id from tenants where slug = ${slug})`;
  });
  await signIn(page, owner, undefined, "/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Website connection" }).click();
  await page.getByRole("tab", { name: "Inline booking" }).click();
  await page.getByLabel(/website origin/i).fill(site);
  await page.getByRole("button", { name: /Copy .* installation code/ }).click();
  await expect(page.getByText("is allowed to show your booking page.")).toBeVisible();
  await expect(page.getByText(site, { exact: true }).first()).toBeVisible();

  // The header lists the saved site, and only that site.
  const framed = await request.get(`${app}/book/${slug}`);
  const policy = framed.headers()["content-security-policy"] ?? "";
  expect(policy).toContain(site);
  expect(policy).not.toContain("evil.example.net");

  // In a real browser: the saved site's page can show the widget; another site's page is blocked by the browser.
  const frameLoads = async (parentOrigin: string): Promise<boolean> => {
    await page.route(`${parentOrigin}/**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><iframe id="w" src="${app}/book/${slug}?embed=1" style="width:600px;height:600px"></iframe>` }));
    await page.goto(`${parentOrigin}/`);
    await page.waitForTimeout(1_500);
    const frame = page.frames().find((candidate) => candidate.url().startsWith(`${app}/book/`));
    const body = frame ? await frame.locator("body").innerText().catch(() => "") : "";
    return body.length > 20;
  };
  expect(await frameLoads(site)).toBe(true);
  expect(await frameLoads("https://evil.example.net")).toBe(false);
});
