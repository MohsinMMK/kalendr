import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { startWorker, whatsAppCode, whatsAppCount } from "./support/worker";
import { chooseBookingSlot, expectAccessible, fillCustomerDetails, newCustomer, openTimeStep } from "./support/journey";

// The old-link journey moves a booking, which asks for a one-time code the worker sends to the capture server.
let worker: ChildProcess | undefined;
test.beforeAll(() => { worker = startWorker(); });
test.afterAll(() => { worker?.kill("SIGTERM"); });

const shots = resolve(process.cwd(), "docs/verification/screenshots");

test("the compact booking card: icon view switch, open-time dots, time zone with the booking details", async ({ page }, testInfo) => {
  const width = page.viewportSize()?.width ?? 0;
  const label = width < 500 ? "375" : "1440";
  await page.setViewportSize({ width: width < 500 ? 375 : 1440, height: width < 500 ? 812 : 900 });
  const times = await openTimeStep(page, { slug: "lotus-dental", service: "Dental cleaning", practitioner: "Dr Arjun Shah" });
  await expect(times.first()).toBeVisible();
  // Every open time carries a small dot that screen readers skip.
  const dots = page.locator("[data-open-dot]");
  expect(await dots.count()).toBeGreaterThan(0);
  await expect(dots.first()).toBeVisible();
  await expect(dots.first()).toHaveCSS("border-radius", /.+/);
  await expect(page.locator("[data-open-dot]").first().locator("..")).toHaveAttribute("aria-hidden", "true");
  await expectAccessible(page, testInfo, "booking card");

  if (label === "1440") {
    // Views are icon buttons in the corner, reachable and switchable by keyboard.
    const views = page.getByRole("radiogroup", { name: "View" });
    await expect(views).toBeVisible();
    await expect(views.getByRole("radio", { name: "Month" })).toBeChecked();
    await views.getByRole("radio", { name: "Month" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(views.getByRole("radio", { name: "Week" })).toBeChecked();
    await expect(page.getByRole("radiogroup", { name: "View" }).getByRole("radio")).toHaveCount(3);
    await views.getByRole("radio", { name: "Columns" }).click();
    await expect(views.getByRole("radio", { name: "Columns" })).toBeChecked();
    await views.getByRole("radio", { name: "Month" }).click();
    // The time zone is a row among the booking details.
    await expect(page.getByRole("combobox", { name: "Time zone" })).toBeVisible();
  }
  await page.screenshot({ path: resolve(shots, `booking-card-${label}.png`), fullPage: true });
});

test("an old reschedule link says the booking moved, shows the new time and can never manage it", async ({ page, browser }, testInfo) => {
  const customer = newCustomer("Nadia");
  const firstTime = await chooseBookingSlot(page, { slug: "lotus-dental", service: "Dental cleaning", practitioner: "Dr Arjun Shah" });
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();
  const oldHref = (await page.getByRole("link", { name: "Manage appointment" }).getAttribute("href"))!;
  await page.goto(oldHref);
  await page.getByRole("button", { name: "Change time" }).click();
  const newSlot = page.getByRole("radiogroup").last().getByRole("radio").filter({ hasNotText: firstTime }).first();
  const newTime = (await newSlot.innerText()).trim();
  await newSlot.click();
  const before = await whatsAppCount(customer.phone);
  await page.getByRole("button", { name: "Move appointment" }).click();
  const { code } = await whatsAppCode(customer.phone, before);
  await page.getByRole("group", { name: "Six-digit code" }).getByRole("textbox").first().click();
  await page.waitForTimeout(400);
  await page.keyboard.type(code, { delay: 80 });
  await expect(page.getByRole("status").filter({ hasText: "has been moved to the new time" })).toBeVisible();

  // A fresh browser opens the old link: it lands on "moved", with no way to change anything.
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "192.0.2.77" } });
  const stranger = await context.newPage();
  await stranger.goto(oldHref);
  await expect(stranger.getByRole("heading", { level: 1, name: /was moved/i })).toBeVisible();
  await expect(stranger.getByTestId("moved-new-time")).toBeVisible();
  await expect(stranger.getByRole("link", { name: "Book again" })).toHaveAttribute("href", /^\/book\/lotus-dental\//);
  await expect(stranger.getByRole("button", { name: /change time|cancel/i })).toHaveCount(0);
  expect(newTime).toBeTruthy();
  await expectAccessible(stranger, testInfo, "moved landing");
  await stranger.screenshot({ path: resolve(shots, `old-link-landing-${(page.viewportSize()?.width ?? 0) < 500 ? "375" : "1440"}.png`), fullPage: true });
  await stranger.getByRole("link", { name: "Book again" }).click();
  await expect(stranger).toHaveURL(/\/book\/lotus-dental\//);
  await context.close();
});
