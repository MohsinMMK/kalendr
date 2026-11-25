import { expect, test } from "@playwright/test";

import { expectAccessible, newCustomer, withOwnerDatabase } from "./support/journey";

/**
 * Feature 54: a test page that uses the `Booker` component books through the public API (no iframe and no key). The booking is
 * checked in the database afterwards: it exists, and it is the one made by this page.
 */
test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 181 : 81}` });
});

test("the Booker component books an appointment through the public API", async ({ page }, testInfo) => {
  const customer = newCustomer("Booker");
  await page.goto("/booker-demo?business=lotus-dental");
  await expect(page.getByRole("heading", { level: 2, name: /^Book with / })).toBeVisible();
  await expectAccessible(page, testInfo, "booker service list");

  await page.getByRole("button", { name: /Dental consultation/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Pick a time for Dental consultation" })).toBeVisible();
  await page.locator(".kalendr-booker__time").first().click();

  await expect(page.getByRole("heading", { level: 2, name: "Your details" })).toBeVisible();
  await page.getByLabel("Full name").fill(`${customer.firstName} ${customer.lastName}`);
  await page.getByLabel("Email").fill(customer.email);
  await page.getByLabel("Phone").fill(customer.phone);
  await page.getByRole("checkbox", { name: /I understand and agree/ }).check();
  // The server refuses a booking sent sooner than any person could fill it in.
  await page.waitForTimeout(4_000);
  await page.getByRole("button", { name: "Confirm booking" }).click();

  await expect(page.getByRole("heading", { level: 2, name: "You're booked" })).toBeVisible({ timeout: 20_000 });
  const reference = await page.getByTestId("booker-reference").innerText();
  expect(reference).toMatch(/\S/);
  const rows = await withOwnerDatabase((sql) => sql<{ booking_source: string; status: string }[]>`
    select a.booking_source, a.status from appointments a join patients p on p.id = a.patient_id and p.tenant_id = a.tenant_id
    where p.email = ${customer.email}`);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("booked");
});
