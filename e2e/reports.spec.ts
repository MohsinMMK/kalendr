import { expect, test } from "@playwright/test";

import { expectAccessible, signIn, withOwnerDatabase } from "./support/journey";

test("the owner reads last month's numbers, checks the source campaign and exports a CSV", async ({ page }, testInfo) => {
  const campaign = `diwali${Date.now()}`;
  await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = 'cedar-hair'`;
    const [location] = await sql<{ id: string }[]>`select id from locations where tenant_id = ${tenant!.id} limit 1`;
    const [practitioner] = await sql<{ id: string }[]>`select id from practitioners where tenant_id = ${tenant!.id} limit 1`;
    const [service] = await sql<{ id: string }[]>`select id from services where tenant_id = ${tenant!.id} limit 1`;
    // The desktop and phone runs share one database: start from a clean March.
    await sql`delete from appointments where tenant_id = ${tenant!.id} and starts_at >= '2026-03-01' and starts_at < '2026-04-01'`;
    const [patient] = await sql<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${tenant!.id}, 'Report', 'Customer', '+919800055566', ${`report-${Date.now()}@example.com`}, 'email') returning id`;
    const statuses = ["completed", "completed", "completed", "no_show"];
    for (const [index, status] of statuses.entries()) {
      await sql`
        insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor, utm_campaign)
        values (${tenant!.id}, ${location!.id}, ${patient!.id}, ${practitioner!.id}, ${service!.id}, ${`2026-03-0${index + 2}T05:00:00Z`}::timestamptz, ${`2026-03-0${index + 2}T05:30:00Z`}::timestamptz,
          ${status}, 'online', ${`e2e${Date.now()}${index}${Math.random()}`.padEnd(64, "0")}, 50000, ${index < 2 ? campaign : null})`;
    }
  });
  await signIn(page, "cedar.owner@example.com");
  await page.goto("/reports?range=custom&from=2026-03-01&to=2026-03-31");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByTestId("metric-bookings")).toHaveText("4");
  await expect(page.getByTestId("metric-no_show_rate")).toHaveText("25%");
  // Every figure says how it is worked out.
  await expect(page.getByText("No-show rate: no-shows ÷ visits that were due").first()).toBeVisible();
  await expectAccessible(page, testInfo, "reports overview");

  await page.getByRole("tab", { name: "Sources" }).click();
  await expect(page.getByRole("cell", { name: campaign }).first()).toBeVisible();

  await page.getByRole("tab", { name: "Bookings" }).click();
  await page.getByRole("tab", { name: "Table" }).first().click();
  await expect(page.getByRole("columnheader", { name: "Bookings" }).first()).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toBe("kalendr-bookings-2026-03-01-to-2026-03-31.csv");
});
