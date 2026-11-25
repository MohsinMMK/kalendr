import { expect, test } from "@playwright/test";

import { chooseCard, signIn, unique } from "./support/journey";

/**
 * Feature 39: a time picked on the booking page is held for the customer for five minutes, nobody else
 * sees it, letting go gives it back; a visitor in Dubai reads clinic times in Dubai time with a line
 * saying how far apart the clocks are; the layout is in the address; the team page lists everyone.
 */

const DAY = 86_400_000;

type Ids = { locationId: string; serviceId: string; practitionerId?: string };

async function listingFrom(request: import("@playwright/test").APIRequestContext, ids: Ids, from: Date) {
  const response = await request.get("/api/public/availability?" + new URLSearchParams({
    clinicSlug: "lotus-dental", locationId: ids.locationId, serviceId: ids.serviceId, practitionerId: ids.practitionerId ?? "first_available",
    from: from.toISOString(), to: new Date(from.getTime() + DAY).toISOString(),
  }));
  expect(response.status()).toBe(200);
  return (await response.json()).data.slots as Array<{ id: string; startsAt: string; endsAt: string; practitionerId: string }>;
}

/** The first day from three days ahead that has a few open times. The clinic is closed some days, such as weekends. */
async function openDay(request: import("@playwright/test").APIRequestContext, ids: Ids): Promise<Date> {
  for (let offset = 3; offset <= 10; offset += 1) {
    const from = new Date(Date.now() + offset * DAY);
    if ((await listingFrom(request, ids, from)).length > 2) return from;
  }
  throw new Error("No day with open times in the next ten days.");
}

test("a held time disappears for everyone else for five minutes and comes back when it is let go", async ({ page, playwright, baseURL }, testInfo) => {
  // Staff sign-in is limited per address, so this journey signs in from its own address.
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 133 : 33}` });
  const name = `Hold journey ${unique()}`;
  await signIn(page, "kalendr.owner@example.com");
  const created = await page.request.post("/api/staff/services", { data: { name, description: "Made by the booking page journey.", durationMinutes: 30 } });
  expect(created.status()).toBe(201);
  const { serviceId } = (await created.json()).data as { serviceId: string };
  const setup = (await (await page.request.get(`/api/staff/services/${serviceId}`)).json()).data;
  const ids = { locationId: setup.basics.locationIds[0] as string, serviceId };

  // A second visitor, with no sign-in, stands in for "someone else".
  const other = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": "192.0.2.77" } });
  try {
    const day = await openDay(other, ids);
    const listing = (request: import("@playwright/test").APIRequestContext, which: Ids) => listingFrom(request, which, day);
    const slots = await listing(other, ids);
    expect(slots.length).toBeGreaterThan(2);
    // Two starts that do not touch, so letting one go gives that time back whatever the other holds.
    const first = slots[0]!;
    const second = slots.find((slot) => Date.parse(slot.startsAt) >= Date.parse(first.startsAt) + 3_600_000)!;
    expect(second).toBeTruthy();
    const body = (slot: typeof first, extra: object = {}) => ({ clinicSlug: "lotus-dental", locationId: ids.locationId, serviceId, practitionerId: slot.practitionerId, startsAt: slot.startsAt, endsAt: slot.endsAt, ...extra });

    const held = await other.post("/api/public/holds", { data: body(first) });
    expect(held.status()).toBe(201);
    const hold = (await held.json()).data as { holdToken: string; expiresAt: string };
    expect(Date.parse(hold.expiresAt) - Date.now()).toBeGreaterThan(4 * 60_000);

    // The signed-in browser (a different visitor) cannot see it or take it.
    expect((await listing(page.request, ids)).some((slot) => slot.id === first.id)).toBe(false);
    const taken = await page.request.post("/api/public/holds", { data: body(first) });
    expect(taken.status()).toBe(409);

    // Picking another time lets the first go.
    const moved = await other.post("/api/public/holds", { data: body(second, { replaceToken: hold.holdToken }) });
    expect(moved.status()).toBe(201);
    expect((await listing(page.request, ids)).some((slot) => slot.id === first.id)).toBe(true);
    expect((await listing(page.request, ids)).some((slot) => slot.id === second.id)).toBe(false);

    // Letting go returns the time at once.
    const released = await other.delete("/api/public/holds", { data: { clinicSlug: "lotus-dental", holdToken: (await moved.json()).data.holdToken } });
    expect(released.status()).toBe(200);
    expect((await listing(page.request, ids)).some((slot) => slot.id === second.id)).toBe(true);
  } finally {
    await other.dispose();
  }
});

test.describe("a visitor abroad", () => {
  test.use({ timezoneId: "Asia/Dubai", locale: "en-GB" });

  test("sees times in their own time with a line about the difference, and can share the layout", async ({ page }, testInfo) => {
    const toTimeStep = async (url: string) => {
      await page.goto(url);
      await chooseCard(page, "Dental consultation");
      await chooseCard(page, "Dr Kavya Rao");
      await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
    };
    await toTimeStep("/book/lotus-dental");
    await expect(page.getByText(/Times shown in Dubai time \(1 h 30 m behind the /)).toBeVisible();

    // The layout lives in the address, so a shared link opens the same view (the phone always shows the month).
    if (testInfo.project.name === "desktop") {
      await page.getByRole("radio", { name: "Week" }).click();
      await expect(page).toHaveURL(/layout=week/);
      const shared = new URL(page.url());
      await toTimeStep(`${shared.pathname}${shared.search}`);
      await expect(page.getByRole("radio", { name: "Week" })).toBeChecked();
    }
  });
});

test("the team page lists every person who takes bookings with their next free time", async ({ page }) => {
  await page.goto("/b/lotus-dental/team");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Dr Kavya Rao").first()).toBeVisible();
  await expect(page.getByText(/Next free:|No free times in the next week/).first()).toBeVisible();
  // The short link to a person moves to their page.
  const profile = await page.getByRole("link", { name: "Dr Kavya Rao" }).first().getAttribute("href");
  expect(profile).toMatch(/\/team\//);
  const id = profile!.split("/").pop()!;
  await page.goto(`/b/lotus-dental/${id}`);
  await expect(page).toHaveURL(new RegExp(`/b/lotus-dental/team/${id}`));
});

test("a team card on the business page opens the person's details in a drawer, with a way to book", async ({ page }, testInfo) => {
  await page.goto("/b/lotus-dental");
  const name = page.getByRole("link", { name: "Dr Kavya Rao" }).first();
  // The name still links to the profile page for a new tab and for search engines.
  expect(await name.getAttribute("href")).toMatch(/\/b\/lotus-dental\/team\//);
  await name.click();
  const drawer = page.getByRole("dialog", { name: "Dr Kavya Rao" });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/\/b\/lotus-dental$/);
  const book = drawer.getByRole("link", { name: /^Book with Kavya/ });
  await expect(book).toBeVisible();
  await expect(book).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("team-drawer.png") });
  await book.click();
  await expect(page).toHaveURL(/\/book\/lotus-dental\?person=/);
  // Booking starts at the service: nobody is asked whether they are new or returning.
  await expect(page.getByText(/first time|new or returning/i)).toHaveCount(0);
});
