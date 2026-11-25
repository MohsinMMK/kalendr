import { type ChildProcess } from "node:child_process";

import { expect, test } from "@playwright/test";

import { expectAccessible, signIn, withOwnerDatabase } from "./support/journey";
import { startWorker } from "./support/worker";

const owner = "kalendr.owner@example.com";
const slug = "lotus-dental";
const captureUrl = process.env.KALENDR_CAPTURE_URL ?? "http://127.0.0.1:3199";

let worker: ChildProcess | undefined;
test.beforeAll(() => { worker = startWorker(); });
test.afterAll(() => { worker?.kill("SIGTERM"); });

/** Starts from a clean slate: the preset can only be on once per business. */
async function removeRecall(): Promise<void> {
  await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    await sql`delete from campaign_sends where tenant_id = ${tenant!.id}`;
    await sql`delete from campaigns where tenant_id = ${tenant!.id}`;
  });
}

test("an owner turns on the 6-month recall, opens it, sends themselves a test and sees it was sent", async ({ page }, testInfo) => {
  await removeRecall();
  await signIn(page, owner, undefined, "/campaigns");
  await expect(page.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();
  await expect(page.getByText("No campaigns yet")).toBeVisible();
  const presets = page.getByRole("list", { name: "Ready-made campaigns" });
  await expect(presets.getByText("Birthday greeting")).toBeVisible();
  await expectAccessible(page, testInfo, "campaigns");

  // The recall needs a choice: which service, and how long after it.
  await presets.getByRole("button", { name: /Turn on .*recall/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(dialog.getByText(/and a number of days, 7 or more/)).toBeVisible();
  await dialog.getByRole("combobox", { name: / 1$/ }).click();
  await page.getByRole("option").first().click();
  await dialog.getByRole("button", { name: "Turn on", exact: true }).click();

  // It opens on the new campaign: who it reaches, what a customer gets, and no test yet.
  const sheet = page.getByRole("dialog").filter({ has: page.getByText("Who it reaches") });
  await expect(sheet.getByText(/Reaches \d+ /)).toBeVisible();
  await expect(sheet.getByText("Only staff see this")).toBeVisible();
  await expect(sheet.getByText("Unsubscribed", { exact: true })).toBeVisible();
  await expect(sheet).toContainText("Automated · Email");

  // It is in the list, and the address names it.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("list", { name: "Campaigns" }).getByText(/recall/i).first()).toBeVisible();
  await page.getByRole("list", { name: "Campaigns" }).getByRole("button", { name: /Open .*recall/i }).click();
  await expect(page).toHaveURL(/campaign=/);

  // Send me a test: the worker delivers it to the signed-in address, and the screen then says so.
  const detail = page.getByRole("dialog").filter({ has: page.getByText("Who it reaches") });
  await detail.getByRole("button", { name: "Send me a test" }).click();
  await expect(detail.getByText(/Test on its way|Test sent for these words/)).toBeVisible();
  await expect(detail.getByText("Test sent for these words.")).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => {
    const messages = (await (await fetch(`${captureUrl}/messages?to=${encodeURIComponent(owner)}`)).json()) as { subject: string; html: string }[];
    return messages.some((message) => message.subject.startsWith("[Test]") && message.html.includes("/api/public/unsubscribe/"));
  }, { timeout: 30_000 }).toBe(true);

  await removeRecall();
});
