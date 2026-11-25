import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { expectAccessible, signIn, withOwnerDatabase } from "./support/journey";

const owner = "kalendr.owner@example.com";
const slug = "lotus-dental";

/** A customer of the sample dental business with a few finished visits, made straight in the database. */
async function seedCustomer(label: string, lastVisitDaysAgo: number): Promise<{ id: string; name: string; email: string }> {
  const suffix = randomUUID().slice(0, 6);
  const firstName = `Profile${label}`;
  const lastName = `Test${suffix}`;
  const email = `${firstName}.${lastName}@example.com`.toLowerCase();
  const id = await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    const [location] = await sql<{ id: string }[]>`select id from locations where tenant_id = ${tenant!.id} limit 1`;
    const [service] = await sql<{ id: string }[]>`select id from services where tenant_id = ${tenant!.id} limit 1`;
    const [practitioner] = await sql<{ id: string }[]>`select id from practitioners where tenant_id = ${tenant!.id} limit 1`;
    const [patient] = await sql<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel, date_of_birth)
      values (${tenant!.id}, ${firstName}, ${lastName}, ${`+9198${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`}, ${email}, 'email', '1988-02-14') returning id`;
    for (let visit = 0; visit < 3; visit += 1) {
      await sql`
        insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor)
        values (${tenant!.id}, ${location!.id}, ${patient!.id}, ${practitioner!.id}, ${service!.id},
          now() - ${lastVisitDaysAgo + visit * 40} * interval '1 day', now() - ${lastVisitDaysAgo + visit * 40} * interval '1 day' + interval '30 minutes',
          'completed', 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, 50000)`;
    }
    return patient!.id;
  });
  return { id, name: `${firstName} ${lastName}`, email };
}

test("staff open a customer, add a note and a tag, block them, and see a segment's count match the database", async ({ page }, testInfo) => {
  const customer = await seedCustomer("Crm", 120);
  await signIn(page, owner, undefined, `/patients?patient=${customer.id}`);
  await expect(page.getByRole("heading", { level: 1, name: customer.name })).toBeVisible();
  await expect(page.getByTestId("customer-summary")).toBeVisible();
  await expect(page.getByTestId("customer-summary").getByText("Next appointment", { exact: true })).toBeVisible();
  await expectAccessible(page, testInfo, "customer profile");

  // History: the three finished visits in one list.
  await page.getByRole("tab", { name: "History" }).click();
  const history = page.getByRole("list", { name: "History, newest first" });
  await expect(history.getByRole("listitem")).toHaveCount(3);

  // Notes.
  await page.getByRole("tab", { name: "Notes" }).click();
  await expect(page.getByText(/not clinical records/i)).toBeVisible();
  await page.getByRole("textbox", { name: "Add a note" }).fill("Prefers early mornings");
  await page.getByRole("checkbox", { name: "Pin to the top of the profile" }).check();
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("list", { name: "Notes" }).getByText("Prefers early mornings")).toBeVisible();
  await expect(page.getByRole("note", { name: "Pinned at the top of the profile" })).toContainText("Prefers early mornings");

  // A tag, made on the spot.
  await page.getByRole("button", { name: "Add a tag" }).click();
  await page.getByRole("textbox", { name: "New tag name" }).fill(`VIP ${randomUUID().slice(0, 4)}`);
  await page.getByRole("button", { name: "Make and add" }).click();
  await expect(page.getByTestId("customer-tags").getByText(/^VIP /)).toBeVisible();
  await page.keyboard.press("Escape");

  // Blocking, from the ⋯ menu.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /Block from booking online/ }).click();
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page.getByText("Say why, so the team knows.")).toBeVisible();
  await page.getByRole("textbox", { name: /Why are you blocking/ }).fill("Missed four visits without a call");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Blocked from booking online" })).toContainText("Missed four visits without a call");
  const [row] = await withOwnerDatabase((sql) => sql<{ blocked_at: Date | null }[]>`select blocked_at from patients where id = ${customer.id}`);
  expect(row?.blocked_at).not.toBeNull();
  await page.getByRole("button", { name: "Unblock" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Blocked from booking online" })).toHaveCount(0);

  // Segments: "no visit in 90 days" counts the same as a hand query.
  await page.goto("/patients");
  await page.getByRole("tab", { name: "Segments" }).click();
  await page.getByRole("button", { name: "New segment" }).first().click();
  const count = page.getByTestId("segment-count");
  await expect(count).toBeVisible();
  const expected = await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    const [hand] = await sql<{ n: number }[]>`
      select count(*)::int as n from patients p
      where p.tenant_id = ${tenant!.id} and p.merged_into_id is null and p.erased_at is null and not p.is_test
        and (select max(a.starts_at) from appointments a where a.patient_id = p.id and a.status = 'completed' and not a.is_test and not a.is_sample) < now() - interval '90 days'`;
    return hand!.n;
  });
  await expect(count).toHaveText(String(expected));
  await expectAccessible(page, testInfo, "segment builder", "[role=dialog]");
  await page.getByRole("textbox", { name: "Name" }).fill(`Lapsed ${randomUUID().slice(0, 4)}`);
  await page.getByRole("button", { name: "Create segment" }).click();
  await expect(page.getByRole("list", { name: "Segments" }).getByText(/No visit in 90 days/).first()).toBeVisible();
});
