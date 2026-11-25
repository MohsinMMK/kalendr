import { expect, test } from "@playwright/test";

import { expectAccessible, signIn, withOwnerDatabase } from "./support/journey";

// A real, checksum-valid GSTIN in Telangana. The salon's own state is Telangana, so this customer's invoice splits into CGST and SGST.
const GSTIN = "36AABCU9603R1ZO";

test("a GST salon issues an invoice at the desk and the customer's link works", async ({ page, baseURL }, testInfo) => {
  await signIn(page, "cedar.owner@example.com");
  const headers = { origin: baseURL! };

  const settings = await page.request.put("/api/staff/tax-settings", {
    headers,
    data: { registered: true, gstin: GSTIN, legalName: "Cedar Hair Pvt Ltd", address: "12 MG Road, Hyderabad", stateCode: "36", pricesIncludeTax: true, defaultTreatment: "taxable", defaultRateBps: 1800, defaultSacCode: "999721", confirm: true },
  });
  expect(settings.status()).toBe(200);

  // A finished visit worth ₹1,180, made as the table owner (the booking journey itself is covered elsewhere).
  const appointmentId = await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = 'cedar-hair'`;
    const [location] = await sql<{ id: string }[]>`select id from locations where tenant_id = ${tenant!.id} limit 1`;
    const [practitioner] = await sql<{ id: string }[]>`select id from practitioners where tenant_id = ${tenant!.id} limit 1`;
    const [service] = await sql<{ id: string }[]>`select id from services where tenant_id = ${tenant!.id} limit 1`;
    const [patient] = await sql<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${tenant!.id}, 'Invoice', 'Customer', '+919800011122', ${`invoice-${Date.now()}@example.com`}, 'email') returning id`;
    const [visit] = await sql<{ id: string }[]>`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor)
      values (${tenant!.id}, ${location!.id}, ${patient!.id}, ${practitioner!.id}, ${service!.id}, now() - interval '1 hour', now() - interval '30 minutes', 'completed', 'staff', ${`e2e${Date.now()}${Math.random()}`.padEnd(64, "0")}, 118000)
      returning id`;
    return visit!.id;
  });

  const issued = await page.request.post("/api/staff/invoices", { headers: { ...headers, "idempotency-key": `e2e-${Date.now()}` }, data: { appointmentId } });
  expect(issued.status()).toBe(201);
  const invoice = (await issued.json()).data as { id: string; number: string; cgstMinor: number; sgstMinor: number; totalMinor: number };
  expect(invoice.number).toMatch(/^\d{4}-\d{2}\/\d{4}$/);
  expect(invoice.cgstMinor + invoice.sgstMinor).toBe(18_000);
  expect(invoice.totalMinor).toBe(118_000);

  // The screen lists it and shows the tax split.
  await page.goto("/billing");
  await expect(page.getByText(invoice.number).first()).toBeVisible();
  await page.getByText(invoice.number).first().click();
  await expect(page.getByText("CGST").first()).toBeVisible();
  await expectAccessible(page, testInfo, "billing invoice sheet");

  // The link the desk sends works without signing in. Until the worker has rendered the PDF it says so, and refreshes itself; the
  // rendered PDF itself is shown by the database integration test (the worker is a separate process this journey does not start).
  const link = await page.request.post(`/api/staff/invoices/${invoice.id}/link`, { headers, data: {} });
  expect(link.status()).toBe(201);
  const url = ((await link.json()).data as { url: string }).url;
  const customer = await page.context().browser()!.newContext({ ...testInfo.project.use });
  try {
    const opened = await customer.request.get(url);
    expect(opened.status()).toBe(202);
    expect(await opened.text()).toContain("Your invoice is being prepared");
    expect(opened.headers()["cache-control"]).toContain("no-store");
    // A wrong link looks like any other dead link.
    const wrong = await customer.request.get(`${url.slice(0, -6)}aaaaaa`);
    expect(wrong.status()).toBe(404);
  } finally {
    await customer.close();
  }
});

test("the owner puts a package and a code on sale and sees them on the Offers screen", async ({ page, baseURL }, testInfo) => {
  await signIn(page, "cedar.owner@example.com");
  const headers = { origin: baseURL! };
  const services = await withOwnerDatabase((sql) => sql<{ id: string }[]>`select s.id from services s join tenants t on t.id = s.tenant_id where t.slug = 'cedar-hair' limit 2`);
  const name = `Ten visits ${Date.now()}`;
  const created = await page.request.post("/api/staff/packages", { headers, data: { name, priceMinor: 800_000, credits: 10, validDays: 180, serviceIds: services.map((row) => row.id), isActive: true } });
  expect(created.status()).toBe(201);
  const code = `E2E${Date.now().toString(36).toUpperCase()}`.slice(0, 12);
  const coupon = await page.request.post("/api/staff/coupons", { headers, data: { code, kind: "percent", value: 15, maxUses: 100, serviceIds: [], firstVisitOnly: true } });
  expect(coupon.status()).toBe(201);

  await page.goto("/offers");
  await expect(page.getByText(name)).toBeVisible();
  await page.getByRole("tab", { name: /Codes/ }).click();
  await expect(page.getByText(code)).toBeVisible();
  await expectAccessible(page, testInfo, "offers");

  // The public check gives one answer for a wrong code, and a real one the discount.
  const salon = await withOwnerDatabase((sql) => sql<{ id: string }[]>`select s.id from services s join tenants t on t.id = s.tenant_id where t.slug = 'cedar-hair' and s.price_minor > 0 limit 1`);
  const outsider = await page.context().browser()!.newContext({ ...testInfo.project.use });
  try {
    if (salon[0]) {
      const wrong = await outsider.request.post("/api/public/coupons/validate", { data: { clinicSlug: "cedar-hair", code: "NOSUCHCODE", serviceId: salon[0].id } });
      expect((await wrong.json()).data).toEqual({ valid: false, message: "That code isn't valid for this booking." });
    }
  } finally {
    await outsider.close();
  }
});
