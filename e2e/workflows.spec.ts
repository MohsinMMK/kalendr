import { expect, test, type Page } from "@playwright/test";

import { expectAccessible, signIn } from "./support/journey";

const owner = "kalendr.owner@example.com";

async function openWorkflows(page: Page): Promise<void> {
  await signIn(page, owner, undefined, "/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Reminders and follow-ups" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Reminders and follow-ups" })).toBeVisible();
  // A new business has none yet: turn on the standard set so there is a 24 hour reminder to change.
  const standardSet = page.getByRole("button", { name: "Turn on the standard set" });
  const list = page.getByText("Your workflows", { exact: true });
  await expect(standardSet.or(list)).toBeVisible();
  if (await standardSet.isVisible()) await standardSet.click();
  await expect(list).toBeVisible();
}

/** The workflow editor, which opens over the settings dialog. */
const editorOf = (page: Page) => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: /(Edit|New) workflow/ }) });

/** Sets the timing of "Reminder 24 hours before" (its name stays, whatever its timing) and saves. */
async function changeReminderTiming(page: Page, hours: string): Promise<void> {
  await page.getByRole("button", { name: "Edit Reminder 24 hours before" }).click();
  const editor = editorOf(page);
  await expect(editor.getByRole("heading", { name: "Edit workflow" })).toBeVisible();
  await editor.getByLabel("Time before the start", { exact: true }).fill(hours);
  await editor.getByRole("button", { name: "Save workflow" }).click();
  await expect(editor).toBeHidden();
}

test("an owner changes a 24 hour reminder to 48 hours and it stays changed", async ({ page }, testInfo) => {
  await openWorkflows(page);
  await expectAccessible(page, testInfo, "reminders and follow-ups");

  await changeReminderTiming(page, "48");
  await expect(page.getByText(/\b48 hours before the/).first()).toBeVisible();

  // Still there after a fresh load.
  await page.reload();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Reminders and follow-ups" }).click();
  await expect(page.getByText(/\b48 hours before the/).first()).toBeVisible();

  // Put it back so the journey can run again.
  await changeReminderTiming(page, "24");
  await expect(page.getByText(/\b24 hours before the/).first()).toBeVisible();
});

test("a message with a value we cannot fill in is refused", async ({ page }) => {
  await openWorkflows(page);
  await page.getByRole("button", { name: "New workflow" }).first().click();
  const editor = editorOf(page);
  await editor.getByLabel("Name", { exact: true }).fill("Broken message");
  await editor.getByLabel("Subject of message 1").fill("Hello");
  await editor.getByLabel("Words of message 1").fill("Hi {unknown}, see you soon.");
  await editor.getByRole("button", { name: "Save workflow" }).click();
  await expect(editor.getByText(/\{unknown\} isn't something we can fill in/)).toBeVisible();
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByText("Broken message")).toHaveCount(0);
});
