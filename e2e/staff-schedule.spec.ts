import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { expectAccessible, newCustomer, signIn, withOwnerDatabase, type Customer } from "./support/journey";

const owner = "kalendr.owner@example.com";

/** Today in India, which is how the schedule counts days. */
function today(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
}

/**
 * A working day well ahead, so a booking is always inside the booking window. The phone project gets the week after the
 * desktop one, and a retry moves two weeks further on, so it never meets the visits its first attempt already booked.
 */
function visitDay(testInfo: TestInfo): string {
  for (let ahead = 4; ahead < 20; ahead += 1) {
    const key = today(ahead);
    if (new Date(`${key}T12:00:00Z`).getUTCDay() === 1) return today(ahead + (testInfo.project.name === "phone" ? 7 : 0) + 14 * (testInfo.retry + testInfo.repeatEachIndex));
  }
  throw new Error("No Monday found.");
}

interface Arranged { customer: Customer; startsAt: string }

/** Books visits through the staff API, the way the booking screen does, so the schedule has real visits to work with. */
async function arrangeVisits(page: Page, day: string, hours: number[], label: string, doctor = "Arjun"): Promise<{ practitionerId: string; visits: Arranged[] }> {
  const snapshot = (await (await page.request.get("/api/staff/snapshot")).json()) as { data: { catalog: { clinic: { slug: string }; locations: { id: string }[]; services: { id: string; name: string }[]; practitioners: { id: string; name: string }[] } } };
  const { catalog } = snapshot.data;
  const service = catalog.services.find((item) => item.name === "Dental consultation");
  const practitioner = catalog.practitioners.find((item) => item.name.includes(doctor));
  if (!service || !practitioner) throw new Error(`The sample business has no consultation or no Dr ${doctor}.`);
  const visits: Arranged[] = [];
  for (const hour of hours) {
    const customer = newCustomer(`${label}${String(hour).replace(".", "")}`);
    const whole = Math.floor(hour);
    const startsAt = `${day}T${String(whole).padStart(2, "0")}:${String(Math.round((hour - whole) * 60)).padStart(2, "0")}:00+05:30`;
    const response = await page.request.post("/api/staff/appointments", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { clinicSlug: catalog.clinic.slug, locationId: catalog.locations[0].id, serviceId: service.id, practitionerId: practitioner.id, startsAt, source: "phone", newPatient: { firstName: customer.firstName, lastName: customer.lastName, phone: customer.phone, email: customer.email, preferredChannel: "email" } },
    });
    expect(response.status(), await response.text()).toBe(201);
    visits.push({ customer, startsAt });
  }
  return { practitionerId: practitioner.id, visits };
}

async function savedStart(email: string): Promise<string> {
  const [row] = await withOwnerDatabase((sql) => sql<{ starts_at: Date }[]>`
    select a.starts_at from appointments a join patients p on p.id = a.patient_id where p.email = ${email}`);
  return row.starts_at.toISOString();
}

async function savedTimes(email: string): Promise<{ start: Date; end: Date; practitioner: string }> {
  const [row] = await withOwnerDatabase((sql) => sql<{ starts_at: Date; ends_at: Date; practitioner_id: string }[]>`
    select a.starts_at, a.ends_at, a.practitioner_id from appointments a join patients p on p.id = a.patient_id where p.email = ${email}`);
  return { start: row.starts_at, end: row.ends_at, practitioner: row.practitioner_id };
}

/**
 * Drags a visit on the day timeline: sideways by 15-minute steps, down by whole staff rows,
 * or (`edge`) by its far end, which changes how long it lasts.
 */
async function dragVisit(page: Page, name: string, { quarterHours = 0, rows = 0, edge = false }: { quarterHours?: number; rows?: number; edge?: boolean }): Promise<void> {
  const card = page.locator("[data-cal-event]").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  // A card that just snapped back is still settling; grab it once it holds still.
  let box = await card.boundingBox();
  for (let tries = 0; tries < 20; tries += 1) {
    await page.waitForTimeout(150);
    const next = await card.boundingBox();
    if (next && box && Math.abs(next.x - box.x) < 0.5 && Math.abs(next.y - box.y) < 0.5) { box = next; break; }
    box = next;
  }
  if (!box) throw new Error("The visit has no position on screen.");
  const rowHeight = (await page.locator('[data-slot="timeline-row"]').first().boundingBox())?.height ?? 96;
  const startX = edge ? box.x + box.width - 3 : box.x + 12;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + 20, y + (rows ? 6 : 0), { steps: 4 });
  await page.mouse.move(startX + quarterHours * 48, y + rows * rowHeight, { steps: 12 });
  await page.mouse.up();
}

test("a dragged visit moves on the server and can be undone, and a clash snaps back with a reason", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Dragging needs a pointer; the phone has the list.");
  const day = visitDay(testInfo);
  await signIn(page, owner);
  const { visits } = await arrangeVisits(page, day, [10, 11, 9], "Drag");
  const [moving, blocking, stretching] = visits;
  const original = await savedStart(moving.customer.email);

  await page.goto(`/schedule?date=${day}&view=staff`);
  await expect(page.locator("[data-cal-event]").filter({ hasText: moving.customer.firstName })).toBeVisible();

  // Onto the next visit: the answer is no, and the card goes back.
  await dragVisit(page, moving.customer.firstName, { quarterHours: 4 });
  await expect(page.getByRole("dialog", { name: new RegExp(`Move ${moving.customer.firstName}`) })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: /^Move appointment$/ }).click();
  await expect(page.getByText("That time is taken")).toBeVisible();
  expect(await savedStart(moving.customer.email)).toBe(original);
  expect(await savedStart(blocking.customer.email)).toContain("T05:");

  // Two hours later, where nothing is booked: it moves, then Undo puts it back.
  await dragVisit(page, moving.customer.firstName, { quarterHours: 8 });
  await page.getByRole("dialog").getByRole("button", { name: /^Move appointment$/ }).click();
  await expect(page.getByText(new RegExp(`Moved ${moving.customer.firstName}`))).toBeVisible();
  expect(await savedStart(moving.customer.email)).not.toBe(original);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => savedStart(moving.customer.email)).toBe(original);

  // Dragging the end of a visit makes it longer by half an hour.
  const before = await savedTimes(stretching.customer.email);
  await dragVisit(page, stretching.customer.firstName, { quarterHours: 2, edge: true });
  await page.getByRole("dialog").getByRole("button", { name: "Change length" }).click();
  await expect(page.getByText(/now ends at/)).toBeVisible();
  await expect.poll(async () => (await savedTimes(stretching.customer.email)).end.getTime() - before.end.getTime()).toBe(30 * 60_000);
  expect((await savedTimes(stretching.customer.email)).start.getTime()).toBe(before.start.getTime());

  // Dragging to the other staff member's row hands the visit over, and Undo hands it back.
  const mine = await savedTimes(moving.customer.email);
  await dragVisit(page, moving.customer.firstName, { rows: 1 });
  await expect(page.getByRole("dialog", { name: new RegExp(`Move ${moving.customer.firstName}`) })).toContainText("Kavya");
  await page.getByRole("dialog").getByRole("button", { name: /^Move appointment$/ }).click();
  await expect.poll(async () => (await savedTimes(moving.customer.email)).practitioner).not.toBe(mine.practitioner);
  // The earlier toast may still be up; this Undo belongs to the move.
  await page.locator("[data-type]").filter({ hasText: /Moved/ }).getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await savedTimes(moving.customer.email)).practitioner).toBe(mine.practitioner);
});

test("the palette finds a customer from part of a phone number", async ({ page }, testInfo) => {
  const day = visitDay(testInfo);
  await signIn(page, owner);
  const { visits } = await arrangeVisits(page, day, [15], "Palette");
  const customer = visits[0].customer;
  await page.goto(`/schedule?date=${day}&view=list`);

  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill(customer.phone.slice(-5));
  const match = dialog.getByRole("option", { name: new RegExp(`^${customer.firstName} ${customer.lastName} ·`) });
  await expect(match).toBeVisible();
  await expectAccessible(page, testInfo, "palette with a result");
  await match.click();
  await expect(page).toHaveURL(/\/patients\?patient=/);
});

test("the view and date stay in the address, and the daily actions work from the keyboard", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Keyboard shortcuts are for the desktop.");
  const day = visitDay(testInfo);
  await signIn(page, owner);
  const { visits } = await arrangeVisits(page, day, [15.5], "Link");
  await page.goto(`/schedule?date=${day}&view=staff`);
  await page.getByRole("group", { name: "Show the schedule as" }).getByRole("button", { name: "List" }).click();
  await expect(page).toHaveURL(/view=list/);
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`date=${day}`));
  await expect(page).toHaveURL(/view=list/);

  // The open appointment is in the address too: a link to it opens the same card.
  await page.getByRole("button", { name: new RegExp(visits[0].customer.firstName) }).click();
  await expect(page).toHaveURL(/open=/);
  await page.reload();
  await expect(page.getByRole("link", { name: "Details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/open=/);

  // Closing the card replaces its entry, so Back steps over it: the list, then the staff view.
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/view=staff/);

  // Arrow keys step the day, T returns to today.
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(new RegExp(`date=${today(0) === day ? today(1) : new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}`));
  await page.keyboard.press("t");
  await expect(page).toHaveURL(new RegExp(`date=${today(0)}`));

  // Typing in a box never triggers a shortcut.
  const search = page.getByRole("searchbox", { name: /Search schedule/ });
  await search.click();
  await search.pressSequentially("nt/?");
  await expect(search).toHaveValue("nt/?");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Shortcuts wait while a dialog is open, so let it finish closing first.
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/\/appointments\/new/);

  // N pressed straight after typing still leaves: the search waits 300 ms before it reaches the address, and that
  // late write must not land during the move and pull the page back to the schedule.
  // The new-booking page is held back 800 ms, as on a slow connection, so the move is still under way when that write is due.
  await page.route(/\/appointments\/new/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto(`/schedule?date=${day}&view=staff`);
  await page.getByRole("searchbox", { name: /Search schedule/ }).fill("zz");
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/\/appointments\/new/);
  await page.waitForTimeout(1_000);
  await expect(page).toHaveURL(/\/appointments\/new/);
});

test("several visits can be cancelled together with a reason", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Choosing several visits is a desktop list feature.");
  const day = visitDay(testInfo);
  await signIn(page, owner);
  const { visits } = await arrangeVisits(page, day, [12, 13], "Bulk");
  await page.goto(`/schedule?date=${day}&view=list`);
  for (const { customer } of visits) await page.getByRole("checkbox", { name: new RegExp(`Select ${customer.firstName}`) }).check();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: /Cancel…/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Reason" }).fill("Doctor is unwell");
  await dialog.getByRole("button", { name: /^Cancel 2$/ }).click();
  await expect(page.getByText("Cancelled 2")).toBeVisible();
  for (const { customer } of visits) {
    const [row] = await withOwnerDatabase((sql) => sql<{ status: string }[]>`select a.status from appointments a join patients p on p.id = a.patient_id where p.email = ${customer.email}`);
    expect(row.status).toBe("cancelled");
  }
});

test("several visits can be handed to another staff member, and a clash stays behind with its reason", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Choosing several visits is a desktop list feature.");
  // The day after the others, so the hours are free.
  const day = new Date(Date.parse(`${visitDay(testInfo)}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await signIn(page, owner);
  await arrangeVisits(page, day, [10], "Cover", "Kavya");
  const { visits } = await arrangeVisits(page, day, [10, 11], "Hand");
  const [clashing, free] = visits;
  await page.goto(`/schedule?date=${day}&view=list`);
  for (const { customer } of visits) await page.getByRole("checkbox", { name: new RegExp(`Select ${customer.firstName}`) }).check();
  await page.getByRole("button", { name: /Move to another/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: /Move to/ }).click();
  await page.getByRole("option", { name: "Dr Kavya Rao" }).click();
  await dialog.getByRole("button", { name: /^Move 2$/ }).click();

  // One moved; the one that clashes is still selected, with the reason beside it.
  await expect(page.getByText("Moved 1. 1 could not be moved")).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(clashing.customer.firstName);
  const [moved] = await withOwnerDatabase((sql) => sql<{ name: string }[]>`select pr.name from appointments a join practitioners pr on pr.id = a.practitioner_id join patients p on p.id = a.patient_id where p.email = ${free.customer.email}`);
  expect(moved.name).toContain("Kavya");
  const [stayed] = await withOwnerDatabase((sql) => sql<{ name: string }[]>`select pr.name from appointments a join practitioners pr on pr.id = a.practitioner_id join patients p on p.id = a.patient_id where p.email = ${clashing.customer.email}`);
  expect(stayed.name).toContain("Arjun");
});

test("the schedule fits a 360px phone and reads well in dark mode", async ({ page, context }, testInfo) => {
  const day = visitDay(testInfo);
  await signIn(page, owner);
  await arrangeVisits(page, day, [14], "Phone");
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/schedule?date=${day}&view=staff`);

  const bar = page.getByRole("navigation", { name: "Main" });
  await expect(bar).toBeVisible();
  for (const name of ["Today", "Schedule", "Patients", "Messages", "More"]) await expect(bar.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: /appointments for/i })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const button of await bar.getByRole("link").all()) expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expectAccessible(page, testInfo, "schedule on a phone, light");

  await context.addCookies([{ name: "kalendr-theme", value: "dark", url: testInfo.project.use.baseURL ?? "http://localhost:3100" }]);
  await page.goto(`/schedule?date=${day}&view=staff`);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectAccessible(page, testInfo, "schedule on a phone, dark");
  await page.setViewportSize({ width: 1366, height: 900 });
  for (const path of [`/schedule?date=${day}&view=list`, `/schedule?date=${day}&view=staff`, `/schedule?date=${day}&view=week`, "/dashboard", "/patients", "/messages", "/doctors"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expectAccessible(page, testInfo, `${path.split("?")[0]} ${/view=(\w+)/.exec(path)?.[1] ?? ""} in dark mode`);
  }
});

test("the day sheet prints one page for each staff member", async ({ page }, testInfo) => {
  const day = visitDay(testInfo);
  await signIn(page, owner);
  const { visits } = await arrangeVisits(page, day, [16], "Sheet");
  await page.goto(`/print/day?date=${day}`);
  await expect(page.getByRole("region", { name: /Dr Arjun Shah/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /Dr Kavya Rao/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: new RegExp(visits[0].customer.lastName) })).toBeVisible();
  await expectAccessible(page, testInfo, "day sheet");

  // On paper: one page for each of the two staff members, none spilling onto a third.
  await page.emulateMedia({ media: "print" });
  const pdf = await page.pdf({ format: "A4" });
  expect((pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(2);
});
