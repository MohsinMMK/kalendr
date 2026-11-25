import { expect, test, type Page } from "@playwright/test";

import { expectAccessible, signIn, withOwnerDatabase } from "./support/journey";
import { freshCode, recallSecret } from "./support/second-factor";

/**
 * Features 55 and 57 in the browser. The owner finds Slack on the Apps page and connects it (the key is sealed and never
 * shown again). Then the extension's device sign-in: a code from the extension, approved on the signed-in screen, tokens
 * that read services and today's bookings but nothing else, and a disconnect from the Apps page that stops them at once.
 */

const owner = "kalendr.owner@example.com";
const slackToken = `xoxb-${"7654321098".repeat(3)}-e2etoken`;

async function confirmStepUp(page: Page): Promise<void> {
  const stepUp = page.getByRole("dialog", { name: "Confirm it's you" });
  if (await stepUp.isVisible({ timeout: 4_000 }).catch(() => false)) {
    await stepUp.getByLabel("Authenticator code").fill(await freshCode(recallSecret(owner)!));
    await stepUp.getByRole("button", { name: "Confirm" }).click();
  }
}

async function openApps(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Apps" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Apps" })).toBeVisible();
}

test("an owner finds Slack on the Apps page, connects it, and the key is kept sealed", async ({ page }, testInfo) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 151 : 51}` });
  await withOwnerDatabase(async (sql) => { await sql`delete from app_installs where app_key = 'slack'`; });
  await signIn(page, owner, undefined, "/settings");
  await openApps(page);

  // Existing integrations are listed beside the apps that install here.
  await expect(page.getByRole("heading", { name: "Webhooks" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search apps" }).fill("slack");
  await expect(page.getByRole("heading", { name: "HubSpot" })).toHaveCount(0);
  await expectAccessible(page, testInfo, "apps-page");

  await page.getByRole("button", { name: "Install" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("What this app receives")).toBeVisible();
  await drawer.getByLabel("Slack bot token").fill("nope");
  await drawer.getByRole("button", { name: "Connect" }).click();
  await confirmStepUp(page);
  await expect(drawer.getByText(/does not look like a Slack bot token/)).toBeVisible();
  await expectAccessible(page, testInfo, "apps-install-drawer", "[role=dialog]");

  await drawer.getByLabel("Slack bot token").fill(slackToken);
  await drawer.getByRole("button", { name: "Connect" }).click();
  await confirmStepUp(page);
  await expect(drawer.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15_000 });
  // The saved key is never put back in the form or the page.
  await expect(drawer.getByLabel("Slack bot token")).toHaveCount(0);
  await expect(page.getByText(slackToken)).toHaveCount(0);

  await withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ credentials_ciphertext: string; settings: unknown; status: string }[]>`select credentials_ciphertext, settings, status from app_installs where app_key = 'slack'`;
    expect(row?.status).toBe("active");
    expect(row?.credentials_ciphertext).toMatch(/^s1\./);
    expect(JSON.stringify(row)).not.toContain(slackToken);
    const audit = await sql<{ metadata: unknown }[]>`select metadata from audit_events where action like 'app.%'`;
    expect(JSON.stringify(audit)).not.toContain(slackToken);
  });

  // Removing starts a removal; the worker finishes it, so the page shows it as being removed.
  await drawer.getByRole("button", { name: "More for Slack" }).click();
  const remove = page.getByRole("menuitem", { name: "Remove app" });
  await expect(remove).toBeInViewport();
  await page.waitForTimeout(400);
  await remove.click();
  const confirm = page.getByRole("alertdialog", { name: "Remove Slack?" });
  await confirm.getByRole("button", { name: "Remove app" }).click();
  await expect(confirm).toBeHidden();
  await withOwnerDatabase(async (sql) => {
    await expect.poll(async () => (await sql<{ status: string }[]>`select status from app_installs where app_key = 'slack'`)[0]?.status).toBe("uninstalling");
    await sql`delete from app_installs where app_key = 'slack'`;
    await sql`delete from outbox_events where event_type in ('app.check', 'app.remove') and status <> 'delivered'`;
  });
});

test("the extension connects with a code, reads only what it was given, and disconnecting stops it", async ({ page, request }, testInfo) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 152 : 52}` });
  const started = await request.post("/api/oauth/device", { form: { client_id: "kalendr-extension" } });
  expect(started.status()).toBe(200);
  const device = (await started.json()) as { device_code: string; user_code: string; verification_uri_complete: string };

  // Signed out, the approval page sends the person to sign in and back again.
  await page.goto(`/oauth/device?code=${device.user_code}`);
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  await signIn(page, owner, undefined, `/oauth/device?code=${device.user_code}`);
  await expect(page).toHaveURL(/\/oauth\/device/);
  await expect(page.getByLabel("Code from the extension")).toHaveValue(device.user_code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Kalendr browser extension")).toBeVisible();
  await expect(page.getByText("Make single-use booking links")).toBeVisible();
  await expect(page.getByText("See today's bookings")).toBeVisible();
  await expectAccessible(page, testInfo, "device-approval");
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("Go back to the extension")).toBeVisible();

  const tokenResponse = await request.post("/api/oauth/token", { form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: "kalendr-extension" } });
  expect(tokenResponse.status()).toBe(200);
  const tokens = (await tokenResponse.json()) as { access_token: string };
  const auth = { Authorization: `Bearer ${tokens.access_token}` };

  const services = await request.get("/api/ext/services", { headers: auth });
  expect(services.status()).toBe(200);
  expect(((await services.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0);
  expect((await request.get("/api/ext/today", { headers: auth })).status()).toBe(200);
  // Not part of what it was given.
  expect((await request.get("/api/v1/appointments", { headers: auth })).status()).toBe(403);
  expect((await request.get("/api/v1/customers", { headers: auth })).status()).toBe(403);

  await page.goto("/settings");
  await openApps(page);
  await page.getByRole("tab", { name: "Signed in" }).click();
  await expect(page.getByText("Kalendr browser extension")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).first().click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden();
  expect((await request.get("/api/ext/services", { headers: auth })).status()).toBe(401);
});
