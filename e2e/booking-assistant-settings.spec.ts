import { expect, test } from "@playwright/test";

import { expectAccessible, signIn, withOwnerDatabase } from "./support/journey";

/**
 * Feature 30, the owner's side: Settings > Booking assistant. The owner turns the website chat on and writes what the assistant
 * should know, saves, and sees the switch hold after a reload. The list of chats waiting for a person is empty and says so.
 * The staff copilot opens from the header.
 */

const owner = "kalendr.owner@example.com";

// Later journeys must not find the chat button on the booking page, so the switch is put back as it was found: no settings row.
test.afterAll(async () => {
  await withOwnerDatabase((sql) => sql`delete from assistant_settings where tenant_id = (select id from tenants where slug = 'lotus-dental')`);
});

test("an owner sets up the assistant and sees nothing waiting, then opens the copilot", async ({ page }, testInfo) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 152 : 52}` });
  await withOwnerDatabase(async (sql) => {
    await sql`delete from assistant_conversations where tenant_id = (select id from tenants where slug = 'lotus-dental')`;
    await sql`delete from assistant_settings where tenant_id = (select id from tenants where slug = 'lotus-dental')`;
  });
  await signIn(page, owner, undefined, "/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "AI assistant" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "AI assistant" })).toBeVisible();
  await expect(page.getByText("Two-way text messages are not connected yet.")).toBeVisible();
  await expectAccessible(page, testInfo, "assistant settings");

  await page.getByRole("switch", { name: "Chat on your booking page" }).click();
  await page.getByLabel("What it should know").fill("We close for lunch from 1 to 2 pm.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Assistant settings saved")).toBeVisible();

  const saved = await withOwnerDatabase((sql) => sql<{ enabled_web: boolean; business_facts: string }[]>`select enabled_web, business_facts from assistant_settings where tenant_id = (select id from tenants where slug = 'lotus-dental')`);
  expect(saved[0]).toEqual({ enabled_web: true, business_facts: "We close for lunch from 1 to 2 pm." });
  // The words the owner wrote stay out of the activity log.
  const audit = await withOwnerDatabase((sql) => sql`select metadata from audit_events where action = 'settings.assistant.updated' order by occurred_at desc limit 1`);
  expect(JSON.stringify(audit)).not.toContain("lunch");

  await page.reload();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "AI assistant" }).click();
  await expect(page.getByRole("switch", { name: "Chat on your booking page" })).toBeChecked();
  await expect(page.getByText("Nothing waiting")).toBeVisible();

  // The copilot button is in the header of the staff pages.
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Open the copilot" }).click();
  const copilot = page.getByRole("dialog", { name: "Copilot" });
  await expect(copilot.getByText("Asks and suggests. It never changes anything until you press Confirm.")).toBeVisible();
  await expectAccessible(page, testInfo, "copilot panel");
});
