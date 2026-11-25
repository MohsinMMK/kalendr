import type { ChildProcess } from "node:child_process";

import { expect, test } from "@playwright/test";

import { startWorker, whatsAppCode, whatsAppCount } from "./support/worker";
import { chooseBookingSlot, chooseCard, expectAccessible, fillCustomerDetails, newCustomer } from "./support/journey";

// Moving or cancelling asks for a one-time code (feature 8), which the worker sends to the capture server.
let worker: ChildProcess | undefined;
test.beforeAll(() => { worker = startWorker(); });
test.afterAll(() => { worker?.kill("SIGTERM"); });

test("a customer moves and then cancels a booking from the manage link", async ({ page }, testInfo) => {
  const customer = newCustomer("Meera");
  const firstTime = await chooseBookingSlot(page, { slug: "lotus-dental", service: "Dental cleaning", practitioner: "Dr Arjun Shah" });
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();

  const manageHref = await page.getByRole("link", { name: "Manage appointment" }).getAttribute("href");
  expect(manageHref).toMatch(/^\/manage\//);
  await page.goto(manageHref!);
  await expect(page.getByRole("heading", { level: 1, name: "Your appointment" })).toBeVisible();
  await expect(page.getByText(firstTime, { exact: false }).first()).toBeVisible();
  await expectAccessible(page, testInfo, "manage page");

  // Reschedule to a different opening.
  await page.getByRole("button", { name: "Change time" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Choose a new time" })).toBeVisible();
  await expectAccessible(page, testInfo, "reschedule step");
  const openings = page.getByRole("radiogroup").last().getByRole("radio");
  const newSlot = openings.filter({ hasNotText: firstTime }).first();
  const newTime = (await newSlot.innerText()).trim();
  await newSlot.click();
  const codesBefore = await whatsAppCount(customer.phone);
  await page.getByRole("button", { name: "Move appointment" }).click();
  // This device is not signed in to the portal, so the move asks for the code sent to the booking's contact. After it, the cancel below does not ask again.
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  const { code } = await whatsAppCode(customer.phone, codesBefore);
  await page.getByRole("group", { name: "Six-digit code" }).getByRole("textbox").first().click();
  await page.waitForTimeout(400);
  await page.keyboard.type(code, { delay: 80 });
  await expect(page.getByRole("status").filter({ hasText: "has been moved to the new time" })).toBeVisible();
  await expect(page.getByText(newTime).first()).toBeVisible();

  // Cancel, with a reason.
  await page.getByRole("button", { name: "Cancel appointment" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Cancel your appointment?" })).toBeVisible();
  await expectAccessible(page, testInfo, "cancel dialog");
  await chooseCard(page, "I can't make it");
  await dialog.getByRole("button", { name: "Cancel my appointment" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /cancelled/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change time" })).toHaveCount(0);
  await expectAccessible(page, testInfo, "cancelled booking");
});
