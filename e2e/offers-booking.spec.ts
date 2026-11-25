import { expect, test } from "@playwright/test";

import { chooseBookingSlot, expectAccessible, fillCustomerDetails, newCustomer, signIn, withOwnerDatabase } from "./support/journey";

const slug = "lotus-dental";
const service = "Dental consultation";
let originalPrice: number | null = null;

// The seeded services have no price, and a code needs a price to discount: give the consultation ₹1,000 for this journey and put it back after.
test.beforeAll(async () => {
  await withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ price_minor: number | null }[]>`select s.price_minor from services s join tenants t on t.id = s.tenant_id where t.slug = ${slug} and s.name = ${service}`;
    originalPrice = row?.price_minor ?? null;
    await sql`update services s set price_minor = 100000 from tenants t where t.id = s.tenant_id and t.slug = ${slug} and s.name = ${service}`;
  });
});
test.afterAll(async () => {
  await withOwnerDatabase((sql) => sql`update services s set price_minor = ${originalPrice} from tenants t where t.id = s.tenant_id and t.slug = ${slug} and s.name = ${service}`);
});

test("a customer books with a discount code and the price and redemption are the server's", async ({ page, browser, baseURL }, testInfo) => {
  const owner = await browser.newContext({ ...testInfo.project.use });
  const ownerPage = await owner.newPage();
  await signIn(ownerPage, "kalendr.owner@example.com");
  const code = `E2E${Date.now().toString(36).toUpperCase()}`.slice(0, 14);
  const created = await ownerPage.request.post("/api/staff/coupons", { headers: { origin: baseURL! }, data: { code, kind: "percent", value: 20, serviceIds: [] } });
  expect(created.status()).toBe(201);
  await owner.close();

  const customer = newCustomer("Coupon");
  await chooseBookingSlot(page, { slug, service, practitioner: "Dr Kavya Rao" });
  await fillCustomerDetails(page, customer);

  await page.getByRole("button", { name: "Have a code?" }).click();
  // A wrong code is refused with one plain sentence that says nothing about why.
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("NOSUCHCODE");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("That code isn't valid for this booking.")).toBeVisible();
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code.toLowerCase());
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(/Price ₹800 instead of ₹1,000/)).toBeVisible();
  await expectAccessible(page, testInfo, "booking with a code");

  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();

  const [booking] = await withOwnerDatabase((sql) => sql<{ id: string; price_minor: number }[]>`
    select a.id, a.price_minor from appointments a join patients p on p.id = a.patient_id where p.email = ${customer.email}`);
  expect(booking?.price_minor).toBe(80_000);
  const redemptions = await withOwnerDatabase((sql) => sql<{ discount_minor: number }[]>`select discount_minor from coupon_redemptions where appointment_id = ${booking!.id} and released_at is null`);
  expect(redemptions).toEqual([{ discount_minor: 20_000 }]);
});
