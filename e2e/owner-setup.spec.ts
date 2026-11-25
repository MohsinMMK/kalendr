import { expect, test } from "@playwright/test";

import { chooseCard, expectAccessible, landAfterSignUp, signUpWithEmail, unique, withOwnerDatabase } from "./support/journey";

/**
 * Feature 11: registration asks for four things (and a password), fills the account from the salon template, and the
 * public page is live straight away with the template's services. Replaces the old multi-screen setup journey.
 */
test("an owner registers in four short steps and the public page is live with the template's services", async ({ page }, testInfo) => {
  const suffix = unique();
  const business = `Juniper Salon ${suffix}`;
  const email = `owner.${suffix}@example.com`;
  const password = `journey-pass-${suffix}-${unique()}`;

  await signUpWithEmail(page, testInfo, email, password);
  // Picking a kind moves straight on to its name.
  await chooseCard(page, "Salon");
  await page.getByRole("textbox", { name: "Salon name" }).fill(business);
  await page.getByRole("textbox", { name: "Your full name" }).fill("Neha Journey");
  // Only the email, a password, the kind and the name: no state, city, street address or phone.
  await expect(page.getByRole("textbox", { name: /city|street|phone/i })).toHaveCount(0);
  await expectAccessible(page, testInfo, "name new business");
  await page.getByRole("button", { name: "Create salon" }).click();
  // The email was confirmed by its code, so the owner is signed in at once.
  await landAfterSignUp(page, email, password);
  await page.goto("/dashboard");
  // The tour starts on the first visit; closing it counts as seen, and the dashboard then shows the checklist.
  await expect(page.getByText("Stop 1 of 5")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Close tour" }).click();
  await page.goto("/dashboard");
  await expect(page.getByLabel("Getting started", { exact: true })).toBeVisible();

  // The page is live already: the template put its services and the owner's hours in place.
  const slug = await withOwnerDatabase(async (sql) => (await sql<{ slug: string }[]>`select slug from tenants where name = ${business}`)[0]!.slug);
  expect(slug).toMatch(/^juniper-salon/);
  await page.goto(`/b/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name: business })).toBeVisible();
  const services = page.getByRole("region", { name: "Services" });
  for (const name of [/General visit/, /Haircut/, /Hair colour/, /Hair spa/, /Styling/]) await expect(services.getByRole("link", { name })).toBeVisible();
  await expect(page.getByRole("link", { name: "Book now" }).first()).toBeVisible();
  await expectAccessible(page, testInfo, "new public page");
});
