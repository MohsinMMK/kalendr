import { expect, test, type Page } from "@playwright/test";

import { signIn, unique } from "./support/journey";

/**
 * Lane A of the Cal.com parity wave: the Services page and the full-page service editor.
 * Each run makes its own services so the shared sample businesses are left as they were.
 */
const shots = "docs/verification/2026-11-25-services-page";

async function createService(page: Page, name: string): Promise<string> {
  const response = await page.request.post("/api/staff/services", { data: { name, description: "Made by the services page journey.", durationMinutes: 30 } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { data: { serviceId: string } }).data.serviceId;
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("the Services page lists, searches, switches off, duplicates and deletes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Both widths are checked inside the desktop run.");
  const name = `Journey ${unique()}`;
  await signIn(page, "kalendr.owner@example.com");
  const serviceId = await createService(page, name);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/services");
  const search = page.getByRole("searchbox");
  await search.fill(name);
  const row = page.getByRole("group").filter({ hasText: name }).filter({ has: page.getByRole("switch") }).last();
  await expect(row).toBeVisible();
  await page.screenshot({ path: `${shots}/services-1440.png` });

  const off = page.waitForResponse((response) => response.url().includes(`/api/staff/services/${serviceId}`) && response.request().method() === "PATCH");
  await row.getByRole("switch").click();
  expect((await off).status()).toBe(200);
  const stored = await page.request.get(`/api/staff/services/${serviceId}`);
  expect((await stored.json()).data.basics.isActive).toBe(false);

  await row.getByRole("button", { name: /More actions|More/ }).click();
  await page.getByRole("menuitem", { name: "Hide from booking page" }).click();
  await expect(row.getByText("Hidden", { exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/staff/services/${serviceId}`)).json()).data.basics.visibility).toBe("hidden");

  await row.getByRole("button", { name: /More actions|More/ }).click();
  await page.getByRole("menuitem", { name: /Duplicate/ }).click();
  await expect(page).toHaveURL(/\/services\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`${name} (copy)`);
  const copyId = page.url().split("/").pop()!;

  // Delete the copy from its editor, then the original from the list.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /Delete/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/services$/);
  expect((await page.request.get(`/api/staff/services/${copyId}`)).status()).toBe(404);

  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  await page.getByRole("searchbox").fill(name);
  await noSideScroll(page);
  await page.screenshot({ path: `${shots}/services-375.png` });
  await page.getByRole("group").filter({ hasText: name }).filter({ has: page.getByRole("switch") }).last().getByRole("button", { name: /More actions|More/ }).click();
  await page.getByRole("menuitem", { name: /Delete/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: /^Delete/ }).click();
  await expect(page.getByRole("link", { name })).toHaveCount(0);
});

test("the editor is a page: groups, live preview, search, old link, and every tab fits 375px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Both widths are checked inside the desktop run.");
  const name = `Editor ${unique()}`;
  await signIn(page, "kalendr.owner@example.com");
  const serviceId = await createService(page, name);

  // An older drawer link lands on the page, in the same tab.
  await page.goto(`/settings?section=patient&service=${serviceId}`);
  await expect(page).toHaveURL(new RegExp(`/services/${serviceId}`));

  await page.setViewportSize({ width: 1440, height: 900 });
  const nav = page.getByRole("tablist", { name: "Settings" });
  for (const group of ["Setup", "Booking experience", "Policies", "Automation"]) await expect(nav.getByText(group, { exact: true })).toBeVisible();
  const preview = page.getByTestId("service-preview");
  await expect(preview).toContainText(name);
  await page.getByLabel("Name", { exact: true }).fill(`${name} renamed`);
  await expect(preview).toContainText(`${name} renamed`);
  await page.screenshot({ path: `${shots}/editor-1440.png` });

  await page.getByRole("searchbox", { name: "Search settings" }).fill("cancel");
  await page.getByRole("button", { name: /can cancel online/i }).click();
  await expect(page.getByRole("tab", { name: "Cancelling and moving", selected: true })).toBeVisible();
  await expect(page).toHaveURL(/tab=cancelling/);

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/services/${serviceId}`);
  await expect(page.getByRole("tab", { name: "Timing" })).toBeAttached();
  const tabs = await page.getByRole("tab").allTextContents();
  expect(tabs.length).toBeGreaterThanOrEqual(14);
  for (const label of tabs) {
    await page.getByRole("tab", { name: label.replace(/\s*•$/, ""), exact: true }).click();
    await noSideScroll(page);
  }
  await page.screenshot({ path: `${shots}/editor-375.png` });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("dialog").getByTestId("service-preview")).toBeVisible();
  await page.screenshot({ path: `${shots}/editor-preview-drawer-375.png` });
});
