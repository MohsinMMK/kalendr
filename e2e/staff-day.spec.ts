import { expect, test, type Page } from "@playwright/test";

import { chooseBookingSlot, expectAccessible, fillCustomerDetails, newCustomer, signIn, withOwnerDatabase } from "./support/journey";

const owner = "kalendr.owner@example.com";

/** Runs one action from the appointment page: the action button, then its review step. */
async function recordAction(page: Page, action: string, badge: string): Promise<void> {
  await page.getByRole("button", { name: action, exact: true }).click();
  await page.getByRole("button", { name: `Confirm ${action.toLowerCase()}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Task complete" })).toBeVisible();
  await expect(page.getByText(badge, { exact: true }).first()).toBeVisible();
}

test("a staff member books a phone caller, checks them in and completes the visit", async ({ page }, testInfo) => {
  const customer = newCustomer("Ravi");
  await signIn(page, owner, undefined, "/appointments/new");
  await expect(page).toHaveURL(/\/appointments\/new/);
  await expectAccessible(page, testInfo, "new appointment");

  await page.getByRole("group", { name: "Patient type" }).getByText("New patient").click();
  await page.getByRole("textbox", { name: "First name" }).fill(customer.firstName);
  await page.getByRole("textbox", { name: "Last name" }).fill(customer.lastName);
  await page.getByRole("textbox", { name: "Phone" }).fill(customer.phone);
  await page.getByRole("textbox", { name: "Email" }).fill(customer.email);
  await page.getByRole("button", { name: "Choose service and time" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Choose an opening" })).toBeVisible();
  await page.getByRole("combobox", { name: "Service" }).click();
  await page.getByRole("option", { name: "Dental consultation · 30 min" }).click();
  await page.getByRole("group", { name: "Show openings as" }).getByText("List").click();

  // Today may already be over; step forward until a day has openings.
  const openings = page.getByRole("region", { name: "Matching openings" }).getByRole("button", { name: /\bDr / });
  for (let day = 0; day < 7 && (await openings.count()) === 0; day += 1) {
    await page.getByRole("button", { name: "Next opening date" }).click();
    await page.getByText("Loading compatible openings…").waitFor({ state: "detached" });
  }
  await expectAccessible(page, testInfo, "choose an opening");
  await openings.first().click();
  await page.getByRole("button", { name: "Review appointment" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Review new appointment" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm appointment" }).click();
  await page.getByRole("link", { name: "Open appointment" }).click();

  await expect(page.getByRole("heading", { level: 1, name: `${customer.firstName} ${customer.lastName}` })).toBeVisible();
  await expectAccessible(page, testInfo, "appointment");
  const appointmentUrl = page.url();
  await recordAction(page, "Check in patient", "Checked in");
  // The finished task keeps the same address, so reopen the appointment to read its saved state.
  await page.goto(appointmentUrl);
  await recordAction(page, "Complete appointment", "Completed");
  await expectAccessible(page, testInfo, "task complete");
});

test("a staff member marks a missed appointment as a no-show", async ({ page }, testInfo) => {
  const customer = newCustomer("Nisha");
  await chooseBookingSlot(page, { slug: "lotus-dental", service: "Dental consultation", practitioner: "Dr Arjun Shah" });
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();

  // The clock cannot be moved in the running app, so the booking is moved into the past instead.
  const [appointment] = await withOwnerDatabase((sql) => sql<{ id: string }[]>`
    UPDATE appointments a
    SET starts_at = a.starts_at - interval '7 days', ends_at = a.ends_at - interval '7 days'
    FROM patients p
    WHERE p.id = a.patient_id AND p.email = ${customer.email}
    RETURNING a.id
  `);
  expect(appointment?.id).toBeTruthy();

  await signIn(page, owner, undefined, `/appointments/${appointment!.id}`);
  await expect(page.getByRole("heading", { level: 1, name: `${customer.firstName} ${customer.lastName}` })).toBeVisible();
  await recordAction(page, "Mark no-show", "No-show");
  await expectAccessible(page, testInfo, "no-show recorded");
});
