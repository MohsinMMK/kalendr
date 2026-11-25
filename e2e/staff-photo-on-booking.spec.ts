import { expect, test } from "@playwright/test";

import { chooseCard, withOwnerDatabase } from "./support/journey";

const person = "Dr Kavya Rao";
// A small solid square, saved the way the team page saves a photo. The browser tests run a production build with no
// virus scanner, which refuses uploads, so the photo is put in place directly; the upload itself is covered by the
// repository tests.
const photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPQqDhBEmIY1TCqYfhqAADDSmgQBaIOewAAAABJRU5ErkJggg==";

test.beforeAll(async () => {
  await withOwnerDatabase((sql) => sql`update practitioners set photo_data_url = ${photo} where name = ${person}`);
});

test.afterAll(async () => {
  await withOwnerDatabase((sql) => sql`update practitioners set photo_data_url = null where name = ${person}`);
});

test("a person's photo shows on the booking page and in the appointment panel", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "One run is enough: both projects share the same person.");

  await page.goto("/b/lotus-dental");
  await page.getByRole("link", { name: "Book now" }).first().click();
  await chooseCard(page, "Dental consultation");
  await expect(page.getByRole("heading", { level: 1, name: "Who would you like to see?" })).toBeVisible();
  await expect(page.locator("label").filter({ hasText: person }).first().locator("img")).toBeVisible();

  await chooseCard(page, person);
  await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeAttached();
  // The Practitioner row of the side panel.
  await expect(page.getByRole("complementary").locator('[aria-labelledby="panel-person-label"] img')).toBeVisible();
});
