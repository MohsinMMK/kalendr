import { createHash, randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";

import { chooseCard, expectAccessible, fillCustomerDetails, newCustomer, withOwnerDatabase } from "./support/journey";

/**
 * Feature 45. A single-use link books once and then shows the "already used" page; a combined link offers the times its
 * people share and books each of them. Links are arranged in the database because their creation screen needs a signed-in
 * owner; what is under test is what a customer sees.
 */
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("a single-use link books once, then says it has been used", async ({ page }, testInfo) => {
  const token = randomBytes(32).toString("base64url");
  const customer = newCustomer("Vera");
  await withOwnerDatabase(async (sql) => {
    const [service] = await sql<{ tenant_id: string; id: string }[]>`
      select service.tenant_id, service.id from services as service join tenants as tenant on tenant.id = service.tenant_id
      where tenant.slug = 'lotus-dental' and service.name = 'Dental consultation'`;
    await sql`insert into special_links (tenant_id, service_id, token_hash, label, kind, max_uses) values (${service!.tenant_id}, ${service!.id}, ${sha256(token)}, 'E2E single use', 'single_use', 1)`;
  });

  await page.goto(`/l/${token}`);
  // The one service this link books is already chosen, so the next question is about the person or the time.
  const person = page.getByRole("heading", { level: 1, name: "Who would you like to see?" });
  if (await person.isVisible().catch(() => false)) {
    await chooseCard(page, "Dr Kavya Rao");
  }
  await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
  await page.getByRole("radiogroup").last().getByRole("radio").first().click();
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();

  await page.goto(`/l/${token}`);
  await expect(page.getByRole("heading", { level: 1, name: "This link has already been used." })).toBeVisible();
  await expect(page.getByText(/Contact the business to book/)).toBeVisible();
  await expectAccessible(page, testInfo, "used link");
  await withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ used_count: number }[]>`select used_count from special_links where token_hash = ${sha256(token)}`;
    expect(row?.used_count).toBe(1);
  });
});

test("an unknown link is a plain not-found page", async ({ page }) => {
  const response = await page.goto(`/l/${randomBytes(32).toString("base64url")}`);
  expect(response?.status()).toBe(404);
});

test("a combined link offers shared times and books each person together", async ({ page }) => {
  const customer = newCustomer("Cleo");
  const slug = `pair-${randomBytes(4).toString("hex")}`;
  const ids = await withOwnerDatabase(async (sql) => {
    const people = await sql<{ tenant_id: string; service_id: string; practitioner_id: string }[]>`
      select service.tenant_id, service.id as service_id, link.practitioner_id
      from services as service
      join tenants as tenant on tenant.id = service.tenant_id
      join practitioner_services as link on link.tenant_id = service.tenant_id and link.service_id = service.id
      join practitioners as practitioner on practitioner.tenant_id = link.tenant_id and practitioner.id = link.practitioner_id and practitioner.is_active
      where tenant.slug = 'lotus-dental' and service.name = 'Dental consultation' order by practitioner.name limit 2`;
    expect(people).toHaveLength(2);
    await sql`insert into combined_links (tenant_id, slug, label, service_id, practitioner_ids)
      values (${people[0]!.tenant_id}, ${slug}, 'E2E pair', ${people[0]!.service_id}, ${people.map((row) => row.practitioner_id)})`;
    return people;
  });

  await page.goto(`/b/lotus-dental/with/${slug}`);
  const person = page.getByRole("heading", { level: 1, name: "Who would you like to see?" });
  if (await person.isVisible().catch(() => false)) {
    await page.locator("label").filter({ hasText: " and " }).first().click();
  }
  await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
  await page.getByRole("radiogroup").last().getByRole("radio").first().click();
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();

  await withOwnerDatabase(async (sql) => {
    const rows = await sql<{ practitioner_id: string; group_ref: string | null }[]>`
      select appointment.practitioner_id, appointment.group_ref from appointments as appointment
      join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
      where patient.email = ${customer.email}`;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.practitioner_id))).toEqual(new Set(ids.map((row) => row.practitioner_id)));
    expect(new Set(rows.map((row) => row.group_ref)).size).toBe(1);
    expect(rows[0]!.group_ref).not.toBeNull();
  });
});
