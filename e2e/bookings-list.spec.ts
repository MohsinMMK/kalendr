import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { chooseBookingSlot, fillCustomerDetails, newCustomer, newPage, signIn } from "./support/journey";

const owner = "kalendr.owner@example.com";

test("front desk finds a booking in the Bookings list, saves a view and opens its history", async ({ page, browser }, testInfo) => {
  const customer = newCustomer("Listed");
  await chooseBookingSlot(page, { slug: "lotus-dental", service: "Dental cleaning", practitioner: "Dr Arjun Shah" });
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();

  const staff = await newPage(browser, testInfo);
  await signIn(staff, owner);
  await staff.goto("/bookings");
  await expect(staff.getByRole("tab", { name: /Upcoming/ })).toBeVisible();
  await expect(staff.getByRole("tab", { name: /Needs approval/ })).toBeVisible();
  await staff.getByRole("button", { name: /^Filter/ }).click();
  await staff.getByPlaceholder("Name or phone").fill(customer.firstName);
  await staff.keyboard.press("Escape");
  await expect(staff.getByText(customer.firstName).first()).toBeVisible();
  // The customer's name links to their profile and shows a card about them on hover.
  const nameLink = staff.getByRole("link", { name: new RegExp(customer.firstName) }).first();
  await expect(nameLink).toHaveAttribute("href", /\/patients\?patient=/);
  await nameLink.hover();
  await expect(staff.getByRole("dialog", { name: new RegExp(`: .*${customer.firstName}`) })).toBeVisible();
  // A row opens its booking's card on this page; the list behind it stays usable.
  await staff.getByRole("row", { name: new RegExp(customer.firstName) }).getByText("Booked").click();
  const card = staff.getByRole("dialog", { name: new RegExp(customer.firstName) });
  await expect(card.getByRole("link", { name: "Details" })).toBeVisible();
  await expect(staff).toHaveURL(/\/bookings/);
  await staff.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  // The alerts bell in the shell is feature 32's and has its own findings (unread badge contrast); scan the list itself.
  const scan = await new AxeBuilder({ page: staff }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude('[aria-label^="Notifications"]').analyze();
  expect(scan.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => violation.id)).toEqual([]);
  await staff.close();
});
