import { expect, test, type Page } from "@playwright/test";

import { chooseCard, expectAccessible, fillCustomerDetails, newCustomer, signIn, withOwnerDatabase } from "./support/journey";

/**
 * Feature 52: embeds and conversion. An owner builds a popup embed in the share sheet, pastes it into a test page, and the
 * host page hears `slot_selected` and `booked` with no personal details. A service set to redirect sends the customer to the
 * business's thank-you page with the booking id. A Meta pixel loads only after consent and only on the booking page. A short
 * link opens the right service with its campaign tag.
 */
const owner = "kalendr.owner@example.com";
const slug = "lotus-dental";

// The made-up website below is another address on this machine. Chrome's local-network protection refuses one loopback address
// reaching another, which a real website never does, so this journey turns that one check off.
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests"] } });

test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 161 : 61}` });
});

/**
 * The host website: the same machine under another address (127.0.0.1 rather than localhost), which the test config lists as
 * allowed to frame booking. It holds the pasted snippet, and the test itself serves its one page.
 */
async function serveHostPage(page: Page, snippet: string): Promise<string> {
  const url = `http://127.0.0.1:${new URL(process.env.KALENDR_APP_URL!).port}/embed-host-test`;
  await page.route(url, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Host</title></head><body><h1>My website</h1>${snippet}
      <script>
        window.heard = [];
        ["opened","service_selected","slot_selected","booked","failed"].forEach(function (name) {
          window.addEventListener("kalendr:" + name, function (event) { window.heard.push({ name: name, data: event.detail }); });
        });
      </script></body></html>`,
  }));
  return url;
}

test("an owner builds a popup embed, pastes it into a test page, and the page hears the booking with no personal details", async ({ page }, testInfo) => {
  await signIn(page, owner, undefined, "/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Website connection" }).click();
  await page.getByRole("button", { name: "Share and embed" }).click();
  const sheet = page.getByRole("dialog", { name: "Share and embed" });
  await expect(sheet.getByRole("tab", { name: "Link and QR" })).toBeVisible();
  await expectAccessible(page, testInfo, "share sheet");
  await sheet.getByRole("tab", { name: "Website embed" }).click();
  await sheet.getByRole("button", { name: "Popup button" }).click();
  await expect(sheet.getByRole("button", { name: "Book an appointment" })).toBeVisible();
  const snippet = await sheet.getByLabel("Embed snippet").innerText();
  expect(snippet).toContain('data-kalendr-mode="popup"');
  expect(snippet).toContain(`data-kalendr-business="${slug}"`);

  const customer = newCustomer("Embed");
  const hostUrl = await serveHostPage(page, snippet);
  await page.goto(hostUrl);
  await page.getByRole("button", { name: "Book an appointment" }).click();
  const booking = page.frameLocator("iframe");
  await booking.locator("label").filter({ hasText: "Dental consultation" }).first().click();
  await booking.locator("label").filter({ hasText: "Dr Kavya Rao" }).first().click();
  await expect(booking.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
  await booking.getByRole("radiogroup").last().getByRole("radio").first().click();
  await booking.getByRole("textbox", { name: "Full name" }).fill(`${customer.firstName} ${customer.lastName}`);
  await booking.getByRole("textbox", { name: "Mobile number" }).fill(customer.phone);
  await booking.getByRole("textbox", { name: "Email address" }).fill(customer.email);
  await booking.getByRole("checkbox", { name: /I understand and agree/ }).check();
  await page.waitForTimeout(4_000);
  await booking.getByRole("button", { name: "Confirm booking" }).click();
  await expect(booking.getByRole("region", { name: "You’re booked" })).toBeVisible();

  const heard = await page.evaluate(() => (window as unknown as { heard: Array<{ name: string; data: Record<string, string> }> }).heard);
  const names = heard.map((entry) => entry.name);
  expect(names).toEqual(expect.arrayContaining(["opened", "service_selected", "slot_selected", "booked"]));
  const booked = heard.find((entry) => entry.name === "booked")!;
  expect(booked.data.appointmentId).toBeTruthy();
  expect(booked.data.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const everything = JSON.stringify(heard);
  for (const secret of [customer.firstName, customer.lastName, customer.email, customer.phone.replace(/\s/g, ""), "Journey"]) expect(everything).not.toContain(secret);
});

test("a service set to redirect sends the customer to the business's thank-you page with the booking id", async ({ page }) => {
  // A thank-you page must be https in production, so the test serves one on a made-up https address.
  const thanks = "https://shop.example.test/embed-thanks";
  await withOwnerDatabase((sql) => sql`update services set redirect_url = ${thanks}, after_booking = 'redirect', pass_details_on_redirect = true
    where name = 'Dental consultation' and tenant_id = (select id from tenants where slug = ${slug})`);
  try {
    await page.route("https://shop.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Thanks from the business</h1>" }));
    await page.goto(`/book/${slug}`);
    const customer = newCustomer("Redirect");
    await chooseCard(page, "Dental consultation");
    await chooseCard(page, "Dr Kavya Rao");
    await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
    await page.getByRole("radiogroup").last().getByRole("radio").nth(1).click();
    await fillCustomerDetails(page, customer);
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await page.waitForURL(/shop\.example\.test\/embed-thanks\?/, { timeout: 30_000 });
    const url = new URL(page.url());
    expect(url.searchParams.get("kalendr_booking")).toMatch(/^[0-9a-f-]{36}$/);
    expect(url.searchParams.get("kalendr_service")).toBeTruthy();
    expect(url.searchParams.get("kalendr_token")).toBeTruthy();
    expect(page.url()).not.toMatch(new RegExp(`${customer.firstName}|${customer.lastName}|example\\.com`, "i"));
    const check = await page.request.get(`/api/public/booking-summary?token=${encodeURIComponent(url.searchParams.get("kalendr_token")!)}`);
    expect((await check.json()).data.bookingId).toBe(url.searchParams.get("kalendr_booking"));
    await expect(page.getByRole("heading", { name: "Thanks from the business" })).toBeVisible();
  } finally {
    await withOwnerDatabase((sql) => sql`update services set after_booking = 'kalendr_page', redirect_url = null, pass_details_on_redirect = false
      where name = 'Dental consultation' and tenant_id = (select id from tenants where slug = ${slug})`);
  }
});

test("a Meta pixel loads only after consent and only on the booking page, and a short link opens the right service tagged", async ({ page }) => {
  const tenantRows = await withOwnerDatabase((sql) => sql<{ id: string }[]>`select id from tenants where slug = ${slug}`);
  const tenantId = tenantRows[0]!.id;
  const serviceRows = await withOwnerDatabase((sql) => sql<{ slug: string }[]>`select slug from services where tenant_id = ${tenantId} and name = 'Dental consultation'`);
  const serviceSlug = serviceRows[0]!.slug;
  await withOwnerDatabase((sql) => sql`insert into tracking_settings (tenant_id, meta_pixel_id) values (${tenantId}, '123456789012345')
    on conflict (tenant_id) do update set meta_pixel_id = '123456789012345'`);
  await withOwnerDatabase((sql) => sql`insert into booking_short_links (tenant_id, code, label, target_path)
    values (${tenantId}, 'e2e2345', 'E2E card', ${`/book/${slug}/${serviceSlug}?utm_campaign=e2e-print`}) on conflict (code) do nothing`);
  const pixelRequests: string[] = [];
  await page.route("https://connect.facebook.net/**", (route) => {
    pixelRequests.push(route.request().url());
    return route.fulfill({ contentType: "text/javascript", body: "window.__metaLoaded = true;" });
  });
  await page.route("https://www.facebook.com/**", (route) => route.fulfill({ status: 204, body: "" }));
  try {
    // Nothing loads before a choice, and "No thanks" keeps it that way.
    await page.goto(`/book/${slug}`);
    await expect(page.getByRole("region", { name: "Analytics cookies" })).toBeVisible();
    await page.waitForTimeout(500);
    expect(pixelRequests).toEqual([]);
    await page.getByRole("button", { name: "No thanks" }).click();
    await page.reload();
    await page.waitForTimeout(500);
    expect(pixelRequests).toEqual([]);

    // Allowing it loads the pixel on the booking page.
    await page.getByRole("button", { name: /Analytics cookies: off/ }).click();
    await expect.poll(() => pixelRequests.length).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __metaLoaded?: boolean }).__metaLoaded === true)).toBe(true);

    // The business page and a customer's manage page never get it, whatever the choice.
    const before = pixelRequests.length;
    await page.goto(`/b/${slug}`);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => typeof (window as unknown as { fbq?: unknown }).fbq)).toBe("undefined");
    expect(pixelRequests.length).toBe(before);

    // A printed short link opens the right service with the campaign tag filled.
    await page.goto("/s/e2e2345");
    await expect(page).toHaveURL(new RegExp(`/book/${slug}/${serviceSlug}\\?utm_campaign=e2e-print`));
    const [row] = await withOwnerDatabase((sql) => sql<{ clicks: number }[]>`select clicks from booking_short_links where code = 'e2e2345'`);
    expect(row!.clicks).toBeGreaterThan(0);
    expect((await page.request.get("/s/zzzzzzz", { maxRedirects: 0 })).status()).toBe(404);
  } finally {
    await withOwnerDatabase((sql) => sql`delete from tracking_settings where tenant_id = ${tenantId}`);
    await withOwnerDatabase((sql) => sql`delete from booking_short_links where code = 'e2e2345'`);
  }
});

test("the pixel does not follow a customer from the booking page to their private manage page", async ({ page }) => {
  const [tenant] = await withOwnerDatabase((sql) => sql<{ id: string }[]>`select id from tenants where slug = ${slug}`);
  await withOwnerDatabase((sql) => sql`insert into tracking_settings (tenant_id, meta_pixel_id) values (${tenant!.id}, '123456789012345')
    on conflict (tenant_id) do update set meta_pixel_id = '123456789012345'`);
  const pixelRequests: string[] = [];
  await page.route("https://connect.facebook.net/**", (route) => {
    pixelRequests.push(route.request().url());
    return route.fulfill({ contentType: "text/javascript", body: "window.__metaLoaded = true;" });
  });
  await page.route("https://www.facebook.com/**", (route) => route.fulfill({ status: 204, body: "" }));
  try {
    const customer = newCustomer("Pixel");
    await page.goto(`/book/${slug}`);
    await page.getByRole("button", { name: "Allow" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __metaLoaded?: boolean }).__metaLoaded === true)).toBe(true);
    await chooseCard(page, "Dental consultation");
    await chooseCard(page, "Dr Kavya Rao");
    await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
    await page.getByRole("radiogroup").last().getByRole("radio").nth(2).click();
    await fillCustomerDetails(page, customer);
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();
    const before = pixelRequests.length;
    await page.getByRole("link", { name: "Manage appointment" }).click();
    await page.waitForURL(/\/manage\//);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => typeof (window as unknown as { fbq?: unknown }).fbq)).toBe("undefined");
    expect(pixelRequests.length).toBe(before);
  } finally {
    await withOwnerDatabase((sql) => sql`delete from tracking_settings where tenant_id = ${tenant!.id}`);
  }
});
