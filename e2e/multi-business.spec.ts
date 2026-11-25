import { expect, test } from "@playwright/test";

import { expectAccessible, signIn, withOwnerDatabase } from "./support/journey";

/**
 * One login, many businesses: a doctor at Riverbend Care is also added to Cedar Hair Studio with the same login. Signing in
 * lands on the first business by name, the sidebar header becomes a business menu, choosing the other business opens it
 * and keeps it across a reload. Someone with one business sees no menu.
 */
const doctor = "riverbend.ishan@example.com";
const soloOwner = "kalendr.owner@example.com";
const home = { slug: "riverbend-care", name: "Riverbend" };
const other = { slug: "cedar-hair", name: "Cedar Hair Studio" };

test.beforeAll(async () => {
  await withOwnerDatabase(async (sql) => {
    await sql`
      insert into memberships (tenant_id, user_id, role)
      select tenant.id, login.id, 'receptionist'::membership_role from tenants as tenant, auth_users as login
      where tenant.slug = ${other.slug} and login.email = ${doctor}
      on conflict (tenant_id, user_id) do nothing`;
  });
});

test.afterAll(async () => {
  await withOwnerDatabase(async (sql) => {
    await sql`delete from memberships where tenant_id = (select id from tenants where slug = ${other.slug}) and user_id = (select id from auth_users where email = ${doctor})`;
  });
});

test("a person in two businesses switches between them from the sidebar and stays there", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The sidebar is a drawer on a phone; the desktop run covers the menu.");
  await signIn(page, doctor);
  const trigger = page.getByRole("button", { name: /Cedar Hair Studio/ });
  // First business by name when nothing has been chosen yet.
  await expect(trigger).toBeVisible();

  await trigger.click();
  const menu = page.getByRole("menu", { name: "Businesses" });
  await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
  await expect(menu.getByRole("menuitemradio", { name: new RegExp(other.name) })).toBeChecked();
  await expectAccessible(page, testInfo, "business menu open");

  await menu.getByRole("menuitemradio", { name: new RegExp(home.name) }).click();
  await page.waitForURL("**/dashboard");
  await expect(page.getByRole("button", { name: new RegExp(home.name) }).first()).toBeVisible();
  // The choice is remembered across a reload.
  await page.reload();
  await expect(page.getByRole("button", { name: new RegExp(home.name) }).first()).toBeVisible();

  // Taken out of the other business, the person simply has one business again and no menu.
  await withOwnerDatabase(async (sql) => {
    await sql`delete from memberships where tenant_id = (select id from tenants where slug = ${other.slug}) and user_id = (select id from auth_users where email = ${doctor})`;
  });
  await page.reload();
  await expect(page.getByRole("link", { name: new RegExp(home.name) }).first()).toBeVisible();
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
});

test("a person in one business sees a plain business row, not a menu", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Covered on desktop.");
  await signIn(page, soloOwner);
  await expect(page.getByRole("link", { name: /Lotus/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Your businesses|Lotus/ })).toHaveCount(0);
});
