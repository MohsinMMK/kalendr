import { createHash, randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";

import { expectAccessible, withOwnerDatabase } from "./support/journey";

test("a customer rates a finished visit in one tap, and a low score stays private", async ({ page }, testInfo) => {
  const good = randomBytes(32).toString("base64url");
  const bad = randomBytes(32).toString("base64url");
  const names = await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = 'cedar-hair'`;
    const [location] = await sql<{ id: string }[]>`select id from locations where tenant_id = ${tenant!.id} limit 1`;
    const [practitioner] = await sql<{ id: string }[]>`select id from practitioners where tenant_id = ${tenant!.id} limit 1`;
    const [service] = await sql<{ id: string }[]>`select id from services where tenant_id = ${tenant!.id} limit 1`;
    const seeded: string[] = [];
    for (const [token, first] of [[good, "Happy"], [bad, "Unhappy"]] as const) {
      const [patient] = await sql<{ id: string }[]>`
        insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
        values (${tenant!.id}, ${first}, 'Rater', ${`+9198000${Math.floor(Math.random() * 90000 + 10000)}`}, ${`${first}-${Date.now()}@example.com`}, 'email') returning id`;
      const [visit] = await sql<{ id: string }[]>`
        insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor)
        values (${tenant!.id}, ${location!.id}, ${patient!.id}, ${practitioner!.id}, ${service!.id}, now() - interval '3 hours', now() - interval '2 hours', 'completed', 'staff', ${`e2e${Date.now()}${Math.random()}`.padEnd(64, "0")}, 50000) returning id`;
      await sql`
        insert into rating_requests (tenant_id, appointment_id, patient_id, token_hash, expires_at)
        values (${tenant!.id}, ${visit!.id}, ${patient!.id}, ${createHash("sha256").update(token).digest("hex")}, now() + interval '30 days')`;
      seeded.push(`${first} R.`);
    }
    return seeded;
  });

  await page.goto(`/r/${good}`);
  await expect(page.getByText("Tap a star", { exact: true })).toBeVisible();
  await expectAccessible(page, testInfo, "rating page");
  await page.getByRole("radio", { name: "4 stars" }).click();
  await expect(page.getByText("Thanks, you rated 4 stars")).toBeVisible();
  await expect(page.getByLabel("Show on the business page")).toBeChecked();
  await page.reload();
  await expect(page.getByText("Thanks, you rated 4 stars")).toBeVisible();

  await page.goto(`/r/${bad}`);
  await page.getByRole("radio", { name: "1 star" }).click();
  await expect(page.getByLabel("Only for the business")).toBeChecked();

  // The private one is stored as private; the business page's public list never includes it (covered in the database test).
  const stored = await withOwnerDatabase(async (sql) => sql<{ display_name: string; visibility: string }[]>`select display_name, visibility from reviews where display_name in ${sql(names)}`);
  expect(stored.find((row) => row.display_name === "Unhappy R.")?.visibility).toBe("private");
  expect(stored.find((row) => row.display_name === "Happy R.")?.visibility).toBe("public");

  await page.goto("/r/not-a-real-token-not-a-real-token-xx");
  await expect(page.getByText(/404|could not be found|not found/i).first()).toBeVisible();
});
