import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { signIn, unique } from "./support/journey";

/**
 * Feature 36: an owner sets timing, lengths and prices on a service from its editor, the public
 * page follows the rules, a hidden service books from its own link, and a copy is one click.
 * Each run makes its own service so the shared sample businesses are left as they were.
 */

async function createService(page: Page, name: string): Promise<{ serviceId: string }> {
  const response = await page.request.post("/api/staff/services", {
    data: { name, description: "Made by the service setup journey.", durationMinutes: 30 },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data as { serviceId: string };
}

async function openEditor(page: Page, serviceId: string): Promise<void> {
  await page.goto(`/services/${serviceId}`);
  await expect(page.getByRole("tab", { name: "Timing" })).toBeVisible();
}

test("an owner sets timing and lengths and the public page follows", async ({ page }) => {
  const name = `Setup journey ${unique()}`;
  await signIn(page, "kalendr.owner@example.com");
  const { serviceId } = await createService(page, name);

  await openEditor(page, serviceId);
  const editor = page.locator("main");
  await editor.getByRole("tab", { name: "Lengths and prices" }).click();
  await editor.getByLabel("Price (₹)").first().fill("500");
  await editor.getByRole("button", { name: "Add a length" }).click();
  await editor.getByLabel("Minutes").nth(1).fill("45");
  await editor.getByLabel("Price (₹)").nth(1).fill("700");
  await editor.getByRole("button", { name: "Add a length" }).click();
  await editor.getByLabel("Minutes").nth(2).fill("60");
  await editor.getByLabel("Price (₹)").nth(2).fill("900");

  await editor.getByRole("tab", { name: "Timing" }).click();
  await expect(editor.getByText("Applies to new bookings only")).toBeVisible();
  await editor.getByLabel("Buffer after (minutes)").fill("15");
  await editor.getByLabel("Amount", { exact: true }).fill("24");
  await editor.getByRole("combobox", { name: "Minimum notice unit" }).click();
  await page.getByRole("option", { name: "hours" }).click();
  await editor.getByLabel("Days ahead").fill("30");
  const scan = await new AxeBuilder({ page }).include("main").analyze();
  expect(scan.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => violation.id)).toEqual([]);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/saved/i).first()).toBeVisible();

  const stored = await page.request.get(`/api/staff/services/${serviceId}`);
  const setup = (await stored.json()).data;
  expect(setup.timing).toMatchObject({ bufferAfterMinutes: 15, minimumNoticeMinutes: 1440, window: { kind: "rolling_days", days: 30 } });
  expect(setup.lengths.map((length: { minutes: number }) => length.minutes)).toEqual([30, 45, 60]);

  // The public page shows three prices, and slots follow notice, window and length.
  await page.goto(`/book/lotus-dental/${setup.basics.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: /how long/i })).toBeVisible();
  for (const price of ["500", "700", "900"]) await expect(page.getByText(new RegExp(price)).first()).toBeVisible();

  const availability = async (minutes: number, from: Date, to: Date) => {
    const place = await page.request.get("/api/public/availability?" + new URLSearchParams({
      clinicSlug: "lotus-dental", locationId: setup.basics.locationIds[0], serviceId, practitionerId: "first_available",
      from: from.toISOString(), to: to.toISOString(), durationMinutes: String(minutes),
    }));
    return ((await place.json()).data.slots as Array<{ startsAt: string; endsAt: string }>);
  };
  const now = Date.now();
  expect(await availability(30, new Date(now), new Date(now + 20 * 3_600_000))).toEqual([]);
  expect(await availability(30, new Date(now + 31 * 86_400_000), new Date(now + 33 * 86_400_000))).toEqual([]);
  const thirty = await availability(30, new Date(now + 3 * 86_400_000), new Date(now + 5 * 86_400_000));
  const sixty = await availability(60, new Date(now + 3 * 86_400_000), new Date(now + 5 * 86_400_000));
  expect(thirty.length).toBeGreaterThan(sixty.length);
});

test("a hidden service is off the business page but books from its link, and a copy is one click", async ({ page }) => {
  const name = `Hidden journey ${unique()}`;
  await signIn(page, "kalendr.owner@example.com");
  const { serviceId } = await createService(page, name);
  const setup = (await (await page.request.get(`/api/staff/services/${serviceId}`)).json()).data;

  await openEditor(page, serviceId);
  await page.getByRole("button", { name: "More actions" }).click();
  const saved = page.waitForResponse((response) => response.url().includes(`/api/staff/services/${serviceId}`) && response.request().method() === "PATCH");
  await page.getByRole("menuitem", { name: /Hide/ }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText("Hidden").first()).toBeVisible();

  await page.goto("/b/lotus-dental");
  await expect(page.getByText(name)).toHaveCount(0);
  await page.goto(`/book/lotus-dental/${setup.basics.slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/not found/i)).toHaveCount(0);

  await openEditor(page, serviceId);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /Duplicate/ }).click();
  await expect(page.getByText(`${name} (copy)`).first()).toBeVisible();
});
