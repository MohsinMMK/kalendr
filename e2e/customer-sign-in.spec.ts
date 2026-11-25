import { randomBytes, createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";

import { chooseBookingSlot, chooseCard, expectAccessible, fillCustomerDetails, newCustomer, newPage, unique, withOwnerDatabase } from "./support/journey";
import { startWorker, whatsAppCode, whatsAppCount } from "./support/worker";

/**
 * Feature 8: a customer with only a phone number signs in with a WhatsApp code, the sixth code request in an hour from one
 * network is refused, a manage link older than 30 days no longer opens the booking, and cancelling from a forwarded link
 * asks for a code the forwarder does not have. The worker runs in local_capture mode against the capture server.
 */
const appUrl = process.env.KALENDR_APP_URL ?? "http://localhost:3100";
let worker: ChildProcess | undefined;

test.beforeAll(() => { worker = startWorker(); });
test.afterAll(() => { worker?.kill("SIGTERM"); });

/** Every test uses its own network address, so the hourly limits of one never reach another. */
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${1 + Math.floor(Math.random() * 250)}` });
});

const phoneNumber = () => `+9197${String(Number.parseInt(unique(), 16) % 100_000_000).padStart(8, "0")}`;

/** Types a code into the six boxes, clearing whatever an earlier try left there. */
async function typeCode(page: Page, code: string): Promise<void> {
  await page.getByRole("group", { name: "Six-digit code" }).getByRole("textbox").first().click();
  await page.waitForTimeout(400);
  await page.keyboard.press("ControlOrMeta+a");
  for (let index = 0; index < 6; index += 1) await page.keyboard.press("Backspace");
  await page.keyboard.type(code, { delay: 80 });
}

test("a customer with only a phone number signs in with a WhatsApp code", async ({ page }, testInfo) => {
  const phone = phoneNumber();
  await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    await sql`insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${tenant!.id}, 'Phone', ${`Only${unique()}`}, ${phone}, ${`nobody-${unique()}@example.invalid`}, 'whatsapp')`;
  });
  await page.goto("/portal/sign-in");
  await page.getByRole("button", { name: "Phone", exact: true }).click();
  await page.getByRole("textbox", { name: "Phone number" }).fill(phone);
  await expectAccessible(page, testInfo, "phone sign-in");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText(/WhatsApp or text message/i).first()).toBeVisible();

  // The code arrives on WhatsApp as an authentication template: in the body and again in the copy-code button.
  const { code, copyButtonCode } = await whatsAppCode(phone);
  expect(code).toMatch(/^\d{6}$/);
  expect(copyButtonCode).toBe(code);

  // A wrong code is refused and makes the next try wait.
  const wrong = code === "000000" ? "111111" : "000000";
  await typeCode(page, wrong);
  const failure = page.getByRole("alert").filter({ hasText: /code/i });
  await expect(failure).toBeVisible();
  await typeCode(page, code);
  await expect(failure).toContainText(/wait \d+ second/i);

  // After the wait, the right code signs in, and the portal knows this customer by phone.
  await page.waitForTimeout(2_500);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/portal", { timeout: 20_000 });
  await expect(page.getByText(/Signed in as/)).toBeVisible();
});

test("the sixth code request in an hour from one network is refused", async () => {
  const address = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // No cookies are kept between these calls, so it is the network limit that stops the sixth, with six different numbers.
    const response = await fetch(`${appUrl}/api/portal/auth/request`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": address },
      body: JSON.stringify({ kind: "phone", contact: phoneNumber() }),
    });
    statuses.push(response.status);
    if (response.status === 429) expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  }
  expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
});

async function expiredBooking(daysAgo: number): Promise<{ token: string; clinic: string }> {
  const token = randomBytes(24).toString("base64url");
  const clinic = "Lotus Dental Studio";
  await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [link] = await sql<{ location_id: string; service_id: string; practitioner_id: string }[]>`
      select location.location_id, service.service_id, service.practitioner_id
      from practitioner_services as service
      join practitioner_locations as location on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      where service.tenant_id = ${tenant!.id} limit 1`;
    const [patient] = await sql<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${tenant!.id}, 'Old', ${`Link${unique()}`}, ${phoneNumber()}, ${`old-${unique()}@example.com`}, 'email') returning id`;
    await sql`insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash)
      values (${tenant!.id}, ${link!.location_id}, ${patient!.id}, ${link!.practitioner_id}, ${link!.service_id},
        now() - ${daysAgo} * interval '1 day' - interval '30 minutes', now() - ${daysAgo} * interval '1 day', 'completed', 'staff',
        ${createHash("sha256").update(token).digest("hex")})`;
  });
  return { token, clinic };
}

test("a manage link from a visit 31 days ago no longer opens the booking", async ({ page }, testInfo) => {
  const old = await expiredBooking(31);
  const response = await page.goto(`/manage/${old.token}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to see this booking" })).toBeVisible();
  // Nothing about the business or the booking is shown, only the way in.
  await expect(page.getByText(old.clinic)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/portal/sign-in");
  await expectAccessible(page, testInfo, "expired manage link");
  const api = await page.request.get(`/api/public/appointments/${old.token}`);
  expect(api.status()).toBe(410);
  expect((await api.json()).error.code).toBe("manage_link_expired");

  // A visit from 29 days ago still opens.
  const recent = await expiredBooking(29);
  await page.goto(`/manage/${recent.token}`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to see this booking" })).toHaveCount(0);
  await expect(page.getByText(old.clinic).first()).toBeVisible();
});

test("cancelling from a forwarded link asks for a code the forwarder does not have", async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const customer = newCustomer("Fwd");
  await chooseBookingSlot(page, { slug: "lotus-dental", service: "Dental cleaning", practitioner: "Dr Arjun Shah" });
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();
  const manageHref = await page.getByRole("link", { name: "Manage appointment" }).getAttribute("href");

  // The link is forwarded: someone else opens it on their own device. Viewing is fine.
  const forwarder = await newPage(browser, testInfo);
  await forwarder.goto(manageHref!);
  await expect(forwarder.getByRole("heading", { level: 1, name: "Your appointment" })).toBeVisible();
  const before = await whatsAppCount(customer.phone);
  await forwarder.getByRole("button", { name: "Cancel appointment" }).click();
  await chooseCard(forwarder, "I booked by mistake");
  await forwarder.getByRole("dialog", { name: "Cancel your appointment?" }).getByRole("button", { name: "Cancel my appointment" }).click();
  await expect(forwarder.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await expectAccessible(forwarder, testInfo, "step-up code dialog");

  // The code went to the contact on the booking, not to the forwarder. A guess does not work.
  const { code } = await whatsAppCode(customer.phone, before);
  const guess = code === "123456" ? "654321" : "123456";
  await typeCode(forwarder, guess);
  await expect(forwarder.getByRole("alert").filter({ hasText: /code/i })).toBeVisible();
  await expect(forwarder.getByRole("heading", { level: 1, name: /cancelled/i })).toHaveCount(0);

  // The customer, who has the code, can cancel.
  await forwarder.waitForTimeout(2_500);
  await typeCode(forwarder, code);
  await forwarder.getByRole("button", { name: "Continue" }).click({ timeout: 1_500 }).catch(() => undefined);
  await expect(forwarder.getByRole("heading", { level: 1, name: /cancelled/i })).toBeVisible({ timeout: 20_000 });
  await forwarder.context().close();
});
