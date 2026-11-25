import { expect, test } from "@playwright/test";

import { signIn, unique, withOwnerDatabase } from "./support/journey";
import { freshCode, recallSecret } from "./support/second-factor";

/**
 * Feature 34: the owner opens Settings > Developers, makes an API key, sees the key once, finds it in the list by
 * its prefix only, and revokes it. The page never shows the key again, and the database holds only its hash.
 */

const owner = "kalendr.owner@example.com";

test("an owner makes an API key, sees it once, finds it by prefix and revokes it", async ({ page }, testInfo) => {
  // Staff sign-in is limited per address, so this journey signs in from its own address.
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 141 : 41}` });
  await signIn(page, owner, undefined, "/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Developers" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Developers" })).toBeVisible();

  const name = `Journey key ${unique()}`;
  await page.getByRole("button", { name: "Create key" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create an API key" });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  // A read-only key is the default choice; keep it.
  await dialog.getByRole("button", { name: "Create key" }).click();

  // Eleven minutes since the last second-factor check would ask for a code first.
  const stepUp = page.getByRole("dialog", { name: "Confirm it's you" });
  const reveal = page.getByRole("dialog", { name: "Copy your new key" });
  await expect(stepUp.or(reveal)).toBeVisible({ timeout: 15_000 });
  if (await stepUp.isVisible()) {
    await stepUp.getByLabel("Authenticator code").fill(await freshCode(recallSecret(owner)!));
    await stepUp.getByRole("button", { name: "Confirm" }).click();
  }

  await expect(reveal).toBeVisible();
  await expect(reveal.getByText("We cannot show this again")).toBeVisible();
  const secret = await reveal.getByLabel("API key", { exact: true }).inputValue();
  expect(secret).toMatch(/^kal_live_[A-Za-z0-9_-]{43}$/);
  const prefix = secret.slice(0, "kal_live_".length + 6);
  await reveal.getByRole("button", { name: "I have saved it" }).click();
  await expect(reveal).toBeHidden();

  // The list shows the prefix and never the whole key.
  await expect(page.getByText(`${prefix}…`)).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);
  await withOwnerDatabase(async (sql) => {
    const rows = await sql<{ key_hash: string }[]>`select key_hash from api_keys where prefix = ${prefix}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.key_hash).not.toContain(secret);
  });

  // Revoke from the row menu (a bottom sheet on a phone) and confirm.
  await page.getByRole("button", { name: `More for ${name}` }).click();
  // On a phone the menu is a sheet that slides up; wait for it to settle before pressing.
  const revokeItem = page.getByRole("menuitem", { name: "Revoke key" });
  await expect(revokeItem).toBeInViewport();
  await page.waitForTimeout(400);
  await revokeItem.click();
  const confirm = page.getByRole("alertdialog", { name: "Revoke this key?" });
  await confirm.getByRole("button", { name: "Revoke key" }).click();
  await expect(confirm).toBeHidden();
  const revoked = page.getByRole("list", { name: "Revoked and expired API keys" });
  await expect(revoked.getByText(`${prefix}…`)).toBeVisible();
  await withOwnerDatabase(async (sql) => {
    const rows = await sql<{ revoked_at: Date | null }[]>`select revoked_at from api_keys where prefix = ${prefix}`;
    expect(rows[0]!.revoked_at).not.toBeNull();
    const audit = await sql<{ action: string }[]>`select action from audit_events where action in ('api_key.created', 'api_key.revoked') and metadata->>'prefix' = ${prefix} order by occurred_at`;
    expect(audit.map((row) => row.action)).toEqual(["api_key.created", "api_key.revoked"]);
  });
});
