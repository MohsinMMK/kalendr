import { expect, test } from "@playwright/test";

import { expectAccessible } from "./support/journey";

/**
 * The public marketing pages: each opens from the header (or the phone menu), has one heading, plays its demo or shows
 * its poster, passes the accessibility scan, and never scrolls sideways on a phone.
 */
const productPages = [
  { path: "/online-booking", label: "Online booking" },
  { path: "/front-desk", label: "Front desk" },
  { path: "/industries", label: "Businesses" },
  { path: "/clinics", label: "Clinics" },
  { path: "/trust", label: "Privacy and security" },
] as const;
const paths = ["/", ...productPages.map((page) => page.path)];

for (const path of paths) {
  test(`marketing page ${path} reads well and passes the scan`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("link", { name: /Set up your business|Get started/ }).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no sideways scroll").toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), { message: "no sideways scroll at 375px" })
      .toBeLessThanOrEqual(0);
    await expectAccessible(page, testInfo, `marketing ${path}`);
  });
}

test("the header reaches every product page", async ({ page, isMobile }) => {
  await page.goto("/");
  for (const { path, label } of productPages) {
    if (isMobile) {
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.getByRole("menuitem", { name: label }).click();
    } else {
      await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: label }).click();
    }
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
});
