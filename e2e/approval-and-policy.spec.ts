import type { ChildProcess } from "node:child_process";

import { expect, test } from "@playwright/test";

import { startWorker, whatsAppCode, whatsAppCount } from "./support/worker";
import { chooseBookingSlot, expectAccessible, fillCustomerDetails, newCustomer, newPage, signIn, withOwnerDatabase } from "./support/journey";

const owner = "kalendr.owner@example.com";
const service = "Dental cleaning";

async function setService(columns: { approval_rule?: string; cancel_cutoff_minutes?: number }) {
  await withOwnerDatabase((sql) => sql`
    update services set approval_rule = coalesce(${columns.approval_rule ?? null}, approval_rule),
      booking_mode = case when coalesce(${columns.approval_rule ?? null}, approval_rule) = 'never' then 'instant'::booking_mode else 'request'::booking_mode end,
      cancel_cutoff_minutes = coalesce(${columns.cancel_cutoff_minutes ?? null}, cancel_cutoff_minutes)
    where name = ${service}`);
}

async function reset() {
  await withOwnerDatabase((sql) => sql`update services set approval_rule = 'never', booking_mode = 'instant', cancel_cutoff_minutes = 0 where name = ${service}`);
}

async function book(page: import("@playwright/test").Page, label: string) {
  const customer = newCustomer(label);
  await chooseBookingSlot(page, { slug: "lotus-dental", service, practitioner: "Dr Arjun Shah" });
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: /Confirm booking|Send request/ }).click();
  return customer;
}

async function appointmentFor(email: string): Promise<{ id: string; version: number; token: string | null }> {
  const [row] = await withOwnerDatabase((sql) => sql<{ id: string; version: number }[]>`
    select a.id, a.version from appointments a join patients p on p.id = a.patient_id where p.email = ${email} order by a.created_at desc limit 1`);
  return { id: row!.id, version: row!.version, token: null };
}

// Moving from a manage link asks for a one-time code (feature 8), which the worker sends to the capture server.
let worker: ChildProcess | undefined;
test.beforeAll(() => { worker = startWorker(); });
test.afterAll(() => { worker?.kill("SIGTERM"); });

test.afterEach(async () => {
  await reset();
});

test("a request waits for approval, staff approve it and the customer sees it booked", async ({ page, browser }, testInfo) => {
  await setService({ approval_rule: "always" });
  const customer = await book(page, "Approve");
  await expect(page.getByText(/waiting for approval/i).first()).toBeVisible();
  await expectAccessible(page, testInfo, "request waiting");
  const manageHref = await page.getByRole("link", { name: "Manage appointment" }).getAttribute("href");
  expect(manageHref).toMatch(/^\/manage\//);

  const staff = await newPage(browser, testInfo);
  await signIn(staff, owner);
  const { id, version } = await appointmentFor(customer.email);
  const approved = await staff.request.patch(`/api/staff/appointments/${id}`, { data: { action: "approve", expectedVersion: version } });
  expect(approved.status(), await approved.text()).toBe(200);

  await page.goto(manageHref!);
  await expect(page.getByRole("button", { name: "Change time" })).toBeVisible();
  await expect(page.getByText(/waiting for approval/i)).toHaveCount(0);
  await staff.close();
});

test("a declined request shows the reason and a link to book again", async ({ page, browser }, testInfo) => {
  await setService({ approval_rule: "always" });
  const customer = await book(page, "Decline");
  const manageHref = await page.getByRole("link", { name: "Manage appointment" }).getAttribute("href");
  const staff = await newPage(browser, testInfo);
  await signIn(staff, owner);
  const { id, version } = await appointmentFor(customer.email);
  const declined = await staff.request.patch(`/api/staff/appointments/${id}`, { data: { action: "decline", reason: "fully_booked", expectedVersion: version } });
  expect(declined.status(), await declined.text()).toBe(200);
  await page.goto(manageHref!);
  await expect(page.getByText(/We are fully booked/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Book another time" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel appointment" })).toHaveCount(0);
  await expectAccessible(page, testInfo, "declined request");
  await staff.close();
});

test("inside the cut-off the manage page shows the rule, and a staff request to move opens on the time picker", async ({ page, browser }, testInfo) => {
  await setService({ approval_rule: "never", cancel_cutoff_minutes: 43_200 });
  const customer = await book(page, "Cutoff");
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();
  const manageHref = await page.getByRole("link", { name: "Manage appointment" }).getAttribute("href");
  await page.goto(manageHref!);
  await expect(page.getByRole("button", { name: "Cancel appointment" })).toHaveCount(0);
  await expect(page.getByText(/can't be cancelled online/i)).toBeVisible();
  await expectAccessible(page, testInfo, "cancel blocked");

  const staff = await newPage(browser, testInfo);
  await signIn(staff, owner);
  const { id, version } = await appointmentFor(customer.email);
  const asked = await staff.request.patch(`/api/staff/appointments/${id}`, { data: { action: "request_reschedule", message: "Please choose another day.", expectedVersion: version } });
  expect(asked.status(), await asked.text()).toBe(200);
  await page.goto(`${manageHref}?reschedule=1`);
  await expect(page.getByRole("heading", { level: 1, name: "Choose a new time" })).toBeVisible();
  await page.getByRole("radiogroup").last().getByRole("radio").first().click();
  const codesBefore = await whatsAppCount(customer.phone);
  await page.getByRole("button", { name: "Move appointment" }).click();
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  const { code } = await whatsAppCode(customer.phone, codesBefore);
  await page.getByRole("group", { name: "Six-digit code" }).getByRole("textbox").first().click();
  await page.waitForTimeout(400);
  await page.keyboard.type(code, { delay: 80 });
  await expect(page.getByRole("status").filter({ hasText: "has been moved to the new time" })).toBeVisible();
  const [row] = await withOwnerDatabase((sql) => sql<{ status: string; id: string }[]>`select status, id from appointments where id = ${id}`);
  expect(row).toEqual({ status: "booked", id });
  await staff.close();
});
