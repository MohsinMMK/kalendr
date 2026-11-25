import { expect, test } from "@playwright/test";

import { expectAccessible, signIn, unique, withOwnerDatabase } from "./support/journey";

/**
 * Feature 30, the staff copilot: a front-desk person asks it to find a gap for a customer. It finds a real time and suggests the
 * booking, and nothing is booked until that person presses Confirm. Every tool call and the confirmation are in the activity trail.
 */

const owner = "kalendr.owner@example.com";

test("the copilot finds a time for a customer and books it only when the staff member presses Confirm", async ({ page }, testInfo) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 173 : 73}` });
  const surname = `Copilot${unique().replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;
  const customer = await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [row] = await sql<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${tenant!.id}, 'Meera', ${surname}, ${`+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`}, ${`${surname.toLowerCase()}@example.com`}, 'email') returning id`;
    return { id: row!.id, tenantId: tenant!.id };
  });

  await signIn(page, owner, undefined, "/dashboard");
  await page.getByRole("button", { name: "Open the copilot" }).click();
  const copilot = page.getByRole("dialog", { name: "Copilot" });
  await expectAccessible(page, testInfo, "copilot, empty");
  await copilot.getByLabel("Your question").fill(`Find a slot for ${surname} next week`);
  await copilot.getByRole("button", { name: "Send" }).click();

  const suggestion = copilot.getByRole("group", { name: "Confirm this booking" });
  await expect(suggestion).toBeVisible({ timeout: 20_000 });
  await expect(suggestion.getByText(new RegExp(`Book Meera ${surname} for`))).toBeVisible();
  await expectAccessible(page, testInfo, "copilot, suggestion waiting");
  // A suggestion is not a booking.
  expect(await withOwnerDatabase((sql) => sql`select id from appointments where patient_id = ${customer.id}`)).toHaveLength(0);

  await suggestion.getByRole("button", { name: "Confirm and book" }).click();
  await expect(copilot.getByText(/^Done\. Book Meera/)).toBeVisible();
  await expect(suggestion).toBeHidden();
  expect(await withOwnerDatabase((sql) => sql`select id from appointments where patient_id = ${customer.id} and status in ('booked', 'requested')`)).toHaveLength(1);

  const trail = await withOwnerDatabase((sql) => sql<{ action: string; metadata: { confirmed: boolean } }[]>`
    select action, metadata from audit_events where tenant_id = ${customer.tenantId} and action like 'assistant.copilot.%' order by occurred_at desc limit 20`);
  expect(trail.some((row) => row.action === "assistant.copilot.confirm" && row.metadata.confirmed === true)).toBe(true);
  expect(trail.some((row) => row.action === "assistant.copilot.tool" && row.metadata.confirmed === false)).toBe(true);
});
