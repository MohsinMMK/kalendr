import { expect, test } from "@playwright/test";

import { chooseCard, expectAccessible, fillCustomerDetails, newCustomer } from "./support/journey";

test("a customer books an appointment on the public page", async ({ page }, testInfo) => {
  const customer = newCustomer("Asha");

  await page.goto("/b/lotus-dental");
  await expect(page.getByRole("heading", { level: 1, name: "Lotus Dental Studio" })).toBeVisible();
  await expectAccessible(page, testInfo, "business page");

  await page.getByRole("link", { name: "Book now" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "What would you like to book?" })).toBeVisible();
  await expectAccessible(page, testInfo, "booking first step");

  await chooseCard(page, "Dental consultation");

  await expect(page.getByRole("heading", { level: 1, name: "Who would you like to see?" })).toBeVisible();
  await chooseCard(page, "Dr Kavya Rao");

  await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
  await expectAccessible(page, testInfo, "time step");
  await page.getByRole("radiogroup").last().getByRole("radio").first().click();

  await expect(page.getByRole("heading", { level: 1, name: "Last step: your details" })).toBeVisible();
  await expectAccessible(page, testInfo, "details step");
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: "Confirm booking" }).click();

  const confirmation = page.getByRole("region", { name: "You’re booked" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText("Dental consultation")).toBeVisible();
  await expect(confirmation.getByText("Dr Kavya Rao")).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage appointment" })).toHaveAttribute("href", /^\/manage\/[A-Za-z0-9_-]{20,}$/);
  await expectAccessible(page, testInfo, "confirmation");
});
