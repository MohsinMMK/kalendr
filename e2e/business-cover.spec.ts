import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";

import { expectAccessible, signIn, unique, withOwnerDatabase } from "./support/journey";

const slug = "lotus-dental";
const owner = "kalendr.owner@example.com";
const logoId = randomUUID();
const photoId = randomUUID();

// A wide picture, saved the way an older upload is (in the row itself) and marked as not needing a scan: the browser
// tests run without a virus scanner, which refuses uploads, so the cover is put in place directly.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.setContent(`<body style="margin:0;height:900px;background:linear-gradient(120deg,#0f766e,#5eead4 45%,#fde68a)"></body>`);
  const picture = await page.screenshot({ type: "png" });
  await page.close();
  await withOwnerDatabase(async (sql) => {
    const [business] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    await sql`delete from media_assets where tenant_id = ${business.id} and kind = 'business_cover'`;
    await sql`delete from media_assets where id = ${logoId}`;
    await sql`
      insert into media_assets (id, tenant_id, kind, owner_id, content_type, width, height, byte_size, data, scan_status)
      values (${logoId}, ${business.id}, 'business_logo', ${business.id}, 'image/png', 1600, 900, ${picture.byteLength}, ${picture}, 'skipped')
    `;
    await sql`
      insert into media_assets (id, tenant_id, kind, owner_id, content_type, width, height, byte_size, data, scan_status)
      values (${crypto.randomUUID()}, ${business.id}, 'business_cover', ${business.id}, 'image/png', 1600, 900, ${picture.byteLength}, ${picture}, 'skipped')
    `;
  });
});

test.afterAll(async () => {
  await withOwnerDatabase((sql) => sql`delete from media_assets where id in (${logoId}, ${photoId})`);
  await withOwnerDatabase((sql) => sql`delete from media_assets where kind = 'business_cover' and tenant_id = (select id from tenants where slug = ${slug})`);
});

test("the business page leads with its cover photo, the logo resting on its bottom edge", async ({ page }, testInfo) => {
  await page.goto(`/b/${slug}`);
  const header = page.locator("[data-slot='card']").first();
  const cover = header.locator("img").first();
  await expect(cover).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Lotus Dental" })).toBeVisible();
  await expectAccessible(page, testInfo, "business page with a cover");

  // The logo overlaps the cover's bottom edge, like a profile picture.
  const coverBox = await cover.boundingBox();
  const logoBox = await header.locator("[data-slot='avatar']").first().boundingBox();
  expect(coverBox && logoBox).toBeTruthy();
  expect(logoBox!.y).toBeLessThan(coverBox!.y + coverBox!.height);
  expect(logoBox!.y + logoBox!.height).toBeGreaterThan(coverBox!.y + coverBox!.height);

  if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/cover-${testInfo.project.name}.png` });
});

test("an owner sees the business cover and logo at the top of My profile, at every screen size", async ({ page }, testInfo) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 171 : 71}` });
  await signIn(page, owner, undefined, "/profile");
  const hero = page.locator("section[aria-labelledby='profile-name']");
  const cover = hero.locator("img[data-nimg]");
  await expect(cover).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Lotus Dental" })).toBeVisible();
  await expect(hero.getByRole("button", { name: "Edit cover" })).toBeVisible();
  await expect(hero.getByRole("button", { name: /logo/ })).toBeVisible();
  await expect(hero.getByRole("link", { name: "View booking page" })).toHaveAttribute("href", `/b/${slug}`);
  // The logo also leads the sidebar, in place of the plain mark.
  if (testInfo.project.name !== "phone") {
    await expect(page.locator("[data-sidebar='header'] img, [data-slot='sidebar-header'] img").first()).toBeVisible();
  }
  // The picture controls carry their own dark, frosted backing so they read on any photo.
  for (const control of [hero.getByRole("button", { name: "Edit cover" }), hero.getByRole("button", { name: /logo/ })]) {
    const look = await control.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, blur: getComputedStyle(element).backdropFilter }));
    expect(look.background).toMatch(/^(rgba\(0, 0, 0, 0\.[4-9]|oklab\(0 0 0 \/ 0\.[4-9])/);
    expect(look.blur).toContain("blur");
  }
  // The sections below the header stay where the team expects them.
  await expect(page.getByRole("heading", { level: 2, name: "My calendars" })).toBeVisible();
  await expectAccessible(page, testInfo, "my profile with the business cover");

  // Phone, foldable, tablet and desktop: the logo always rests on the cover's bottom edge and nothing scrolls sideways.
  for (const width of [360, 700, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(cover).toBeVisible();
    await expect.poll(async () => {
      const coverBox = await cover.boundingBox();
      const logoBox = await hero.locator("[data-slot='avatar']").first().boundingBox();
      const edge = coverBox!.y + coverBox!.height;
      return logoBox!.y < edge - 8 && logoBox!.y + logoBox!.height > edge + 8;
    }).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/profile-hero-${width}.png` });
  }

  // The pictures change right here: each control opens the file chooser (uploads themselves need the virus scanner).
  await hero.getByRole("button", { name: "Edit cover" }).click();
  let chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Upload a new cover" }).click();
  await chooser;
  await hero.getByRole("button", { name: /logo/ }).click();
  // The logo's menu opens centred under its camera button.
  const logoButton = await hero.getByRole("button", { name: /logo/ }).boundingBox();
  const logoMenu = await page.getByRole("menu").boundingBox();
  expect(Math.abs(logoMenu!.x + logoMenu!.width / 2 - (logoButton!.x + logoButton!.width / 2))).toBeLessThan(4);
  if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/profile-hero-logo-menu.png` });
  chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: /Upload a (new )?logo/ }).click();
  await chooser;

  // Removing the cover takes it away at once and offers to add one where it was, and it stays gone.
  await hero.getByRole("button", { name: "Edit cover" }).click();
  await page.getByRole("menuitem", { name: "Remove cover" }).click();
  const add = hero.getByRole("button", { name: "Add cover photo" });
  await expect(add).toBeVisible();
  await expect(hero.locator("img[data-nimg]")).toHaveCount(0);
  await page.reload();
  await expect(add).toBeVisible();
  await expectAccessible(page, testInfo, "my profile without a cover");
  chooser = page.waitForEvent("filechooser");
  await add.click();
  await chooser;
  if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/profile-hero-empty.png` });

  // The "On this page" list jumps to a section and keeps it in view.
  await page.getByRole("navigation", { name: "On this page" }).getByRole("link", { name: "Security" }).click();
  await expect(page.locator("#security")).toBeInViewport();
  if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/profile-nav-security.png` });
});

test("a receptionist sees their own name and the business cover on My profile, and changes the pictures only once given the switch", async ({ page }) => {
  const email = `front.${unique()}@example.com`;
  const password = `Pw-${randomUUID()}`;
  const id = randomUUID();
  await withOwnerDatabase(async (sql) => {
    const [business] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    await sql`insert into auth_users (id, name, email, email_verified, password_set_at) values (${id}, 'Riya Front', ${email}, true, now())`;
    await sql`insert into auth_accounts (id, issuer, account_id, provider_id, user_id, password) values (${randomUUID()}, 'local:credential', ${id}, 'credential', ${id}, ${await hashPassword(password)})`;
    await sql`insert into memberships (tenant_id, user_id, role) values (${business.id}, ${id}, 'receptionist')`;
    // They are also bookable, with a photo on their booking profile.
    const [own] = await sql<{ id: string }[]>`
      insert into practitioners (tenant_id, auth_user_id, name, title, initials, specialty)
      values (${business.id}, ${id}, 'Riya Front', 'Hygienist', 'RF', 'Hygiene') returning id
    `;
    const photo = Buffer.from(await (async () => {
      await page.setContent(`<body style="margin:0;background:#7c3aed"></body>`);
      return page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 256, height: 256 } });
    })());
    await sql`
      insert into media_assets (id, tenant_id, kind, owner_id, content_type, width, height, byte_size, data, scan_status)
      values (${photoId}, ${business.id}, 'practitioner', ${own.id}, 'image/png', 256, 256, ${photo.byteLength}, ${photo}, 'skipped')
    `;
  });
  try {
    await page.setViewportSize({ width: 360, height: 800 });
    await signIn(page, email, password, "/profile");
    const hero = page.locator("section[aria-labelledby='profile-name']");
    await expect(page.getByRole("heading", { level: 1, name: "Riya Front" })).toBeVisible();
    await expect(hero.getByText(/Lotus Dental/)).toBeVisible();
    await expect(hero.getByRole("button")).toHaveCount(0);
    // Their own photo leads the account menu at the bottom of the sidebar, in place of their initials.
    await page.getByRole("button", { name: /Toggle Sidebar|Open sidebar|sidebar/i }).first().click();
    await expect(page.locator("[data-sidebar='footer'] img, [data-slot='sidebar-footer'] img").first()).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/profile-hero-receptionist.png` });

    // The server refuses them too, not just the screen.
    const refused = await page.request.post("/api/staff/media", { multipart: { kind: "business_logo", file: { name: "logo.png", mimeType: "image/png", buffer: Buffer.from("not a picture") } } });
    expect(refused.status()).toBe(403);

    // The owner turns on "Change the logo and cover" for them under Team: now the controls appear.
    await withOwnerDatabase((sql) => sql`update memberships set permission_overrides = ${sql.json({ "brand.manage": true })} where user_id = ${id}`);
    await page.reload();
    // "Edit cover", or "Add cover photo" when the owner's test above removed it.
    await expect(hero.getByRole("button", { name: /cover/ })).toBeVisible();
    await expect(hero.getByRole("button", { name: /logo/ })).toBeVisible();
  } finally {
    await withOwnerDatabase(async (sql) => {
      await sql`delete from media_assets where id = ${photoId}`;
      await sql`delete from practitioners where auth_user_id = ${id}`;
      await sql`delete from memberships where user_id = ${id}`;
      await sql`delete from auth_sessions where user_id = ${id}`;
      await sql`delete from auth_accounts where user_id = ${id}`;
      await sql`delete from auth_users where id = ${id}`;
    });
  }
});

test("a receptionist with no booking profile adds their own photo on My profile and sees it in the sidebar", async ({ page }, testInfo) => {
  const othersPhoto = randomUUID();
  const email = `desk.${unique()}@example.com`;
  const password = `Pw-${randomUUID()}`;
  const id = randomUUID();
  await withOwnerDatabase(async (sql) => {
    const [business] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    await sql`insert into auth_users (id, name, email, email_verified, password_set_at) values (${id}, 'Dev Desk', ${email}, true, now())`;
    await sql`insert into auth_accounts (id, issuer, account_id, provider_id, user_id, password) values (${randomUUID()}, 'local:credential', ${id}, 'credential', ${id}, ${await hashPassword(password)})`;
    await sql`insert into memberships (tenant_id, user_id, role) values (${business.id}, ${id}, 'receptionist')`;
  });
  try {
    await signIn(page, email, password, "/profile");
    // No practitioner row: the Name and email section offers "Your photo", and the sidebar shows initials only.
    const account = page.locator("#account");
    await expect(account.getByText("Your photo")).toBeVisible();
    await account.getByRole("button", { name: "Add photo" }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Upload a photo" }).click();
    await chooser;
    const footerPhoto = page.locator("[data-sidebar='footer'] img, [data-slot='sidebar-footer'] img");
    await expect(footerPhoto).toHaveCount(0);

    // A photo row put in directly (the browser tests run without a virus scanner, which refuses uploads).
    const picture = await page.context().newPage();
    await picture.setContent(`<body style="margin:0;background:#7c3aed"></body>`);
    const photo = await picture.screenshot({ type: "png", clip: { x: 0, y: 0, width: 256, height: 256 } });
    await picture.close();
    await withOwnerDatabase(async (sql) => {
      const [business] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
      await sql`
        insert into media_assets (id, tenant_id, kind, owner_id, content_type, width, height, byte_size, data, scan_status)
        values (${randomUUID()}, ${business.id}, 'staff_photo', ${id}, 'image/png', 256, 256, ${photo.byteLength}, ${photo}, 'skipped')
      `;
    });
    await page.goto("/profile");
    await expect(account.getByRole("button", { name: "Change photo" })).toBeVisible();
    await expect(footerPhoto.first()).toBeVisible();

    // The account menu: their photo, then Appearance as a row of Light, Dark and System tabs.
    await page.locator("[data-slot='sidebar-footer'] button, [data-sidebar='footer'] button").first().click();
    const appearance = page.getByRole("group", { name: "Appearance" });
    await expect(appearance.getByRole("menuitemradio")).toHaveCount(3);
    const boxes = await appearance.getByRole("menuitemradio").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top));
    expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(2);
    await expectAccessible(page, testInfo, "account menu with the appearance tabs");
    if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/account-menu-appearance.png` });
    await page.keyboard.press("Escape");

    // Someone else's photo can't be removed: it answers as if it did not exist, and stays.
    await withOwnerDatabase(async (sql) => {
      const [business] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
      await sql`
        insert into media_assets (id, tenant_id, kind, owner_id, content_type, width, height, byte_size, data, scan_status)
        values (${othersPhoto}, ${business.id}, 'staff_photo', ${randomUUID()}, 'image/png', 256, 256, ${photo.byteLength}, ${photo}, 'skipped')
      `;
    });
    const refused = await page.request.delete(`/api/staff/media/${othersPhoto}`);
    expect(refused.status()).toBe(404);
    const [kept] = await withOwnerDatabase((sql) => sql<{ count: number }[]>`select count(*)::int as count from media_assets where id = ${othersPhoto}`);
    expect(kept!.count).toBe(1);

    // The server lets them touch only their own photo: this tiny file is refused as a picture, not as forbidden.
    const own = await page.request.post("/api/staff/media", { multipart: { kind: "staff_photo", file: { name: "p.png", mimeType: "image/png", buffer: Buffer.from("x") } } });
    expect(own.status()).toBe(400);
  } finally {
    await withOwnerDatabase(async (sql) => {
      await sql`delete from media_assets where (kind = 'staff_photo' and owner_id = ${id}) or id = ${othersPhoto}`;
      await sql`delete from memberships where user_id = ${id}`;
      await sql`delete from auth_sessions where user_id = ${id}`;
      await sql`delete from auth_accounts where user_id = ${id}`;
      await sql`delete from auth_users where id = ${id}`;
    });
  }
});
