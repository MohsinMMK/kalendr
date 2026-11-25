import { expect, test, type Page } from "@playwright/test";

import { expectAccessible, newCustomer, withOwnerDatabase, type Customer } from "./support/journey";

// A class with two seats: three customers use the public timetable, the third joins the waiting list, the first cancels from
// their own link, and the third takes the freed seat from theirs. Seats are offered inside the cancel itself, so no worker is
// needed; the page reads the offer straight from the database.
const slug = "lotus-dental";
// Each run books from an address of its own (a documentation address), so rerunning within the hour does not meet the booking limit.
test.use({ extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${20 + Math.floor(Math.random() * 200)}` } });

const dayInIndia = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

interface Setup { tenantId: string; serviceId: string; sessionId: string; className: string }

/** One class with two seats and one session at 10:00 tomorrow (India time), taught by the seeded practitioner at the seeded place. */
async function arrange(): Promise<Setup> {
  const className = `Morning yoga ${Date.now().toString(36)}`;
  return withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ tenant_id: string; location_id: string; practitioner_id: string }[]>`
      select tenant.id as tenant_id, location.id as location_id, person.id as practitioner_id
      from tenants as tenant
      join locations as location on location.tenant_id = tenant.id
      join practitioners as person on person.tenant_id = tenant.id and person.name = 'Dr Arjun Shah'
      where tenant.slug = ${slug} limit 1`;
    if (!row) throw new Error("The seeded business is missing.");
    const [service] = await sql<{ id: string }[]>`
      insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types, price_minor, kind, capacity, minimum_lead_minutes, slot_interval_minutes)
      values (${row.tenant_id}, ${className}, '', 60, 'instant', ARRAY['new','returning']::text[], null, 'class', 2, 60, 60)
      returning id`;
    await sql`insert into service_locations (tenant_id, service_id, location_id) values (${row.tenant_id}, ${service!.id}, ${row.location_id})`;
    await sql`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${row.tenant_id}, ${row.practitioner_id}, ${service!.id})`;
    await sql`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${row.tenant_id}, ${row.practitioner_id}, ${row.location_id}) on conflict do nothing`;
    const tomorrow = dayInIndia(new Date(Date.now() + 86_400_000));
    const startsAt = new Date(`${tomorrow}T10:00:00+05:30`);
    const [session] = await sql<{ id: string }[]>`
      insert into class_sessions (tenant_id, service_id, practitioner_id, location_id, starts_at, ends_at, capacity)
      values (${row.tenant_id}, ${service!.id}, ${row.practitioner_id}, ${row.location_id}, ${startsAt.toISOString()}, ${new Date(startsAt.getTime() + 3_600_000).toISOString()}, 2)
      returning id`;
    return { tenantId: row.tenant_id, serviceId: service!.id, sessionId: session!.id, className };
  });
}

/** Removes the class, its session and seats, and the customers made for the run. */
async function restore(setup: Setup, people: Customer[]): Promise<void> {
  await withOwnerDatabase(async (sql) => {
    await sql`delete from class_sessions where tenant_id = ${setup.tenantId} and service_id = ${setup.serviceId}`;
    await sql`delete from practitioner_services where tenant_id = ${setup.tenantId} and service_id = ${setup.serviceId}`;
    await sql`delete from service_locations where tenant_id = ${setup.tenantId} and service_id = ${setup.serviceId}`;
    await sql`delete from services where tenant_id = ${setup.tenantId} and id = ${setup.serviceId}`;
    for (const person of people) await sql`delete from patients where tenant_id = ${setup.tenantId} and email = ${person.email}`.catch(() => undefined);
  });
}

async function openTimetable(page: Page): Promise<void> {
  await page.goto(`/book/${slug}/classes`);
  await expect(page.getByRole("heading", { level: 1, name: "Class timetable" })).toBeVisible();
}

/** Opens the dialog for the class, fills the form like a customer, sends it and returns the link on the result screen. */
async function takeSeat(page: Page, setup: Setup, person: Customer, button: "Book a seat" | "Join waiting list", submit: "Book my seat" | "Join the waiting list", result: string): Promise<string> {
  await page.getByRole("button", { name: new RegExp(`${button}: ${setup.className}`) }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "First name" }).fill(person.firstName);
  await dialog.getByRole("textbox", { name: "Last name" }).fill(person.lastName);
  await dialog.getByRole("textbox", { name: "Email address" }).fill(person.email);
  await dialog.getByRole("checkbox", { name: /I understand and agree/ }).check();
  await dialog.getByRole("button", { name: submit }).click();
  await expect(dialog.getByText(result)).toBeVisible();
  const href = await dialog.getByRole("link", { name: "See or cancel your place" }).getAttribute("href");
  expect(href).toMatch(/^\/class\/[A-Za-z0-9_-]+$/);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  return href!;
}

test("two seats, three customers: the third joins the waiting list and takes the seat the first gives up", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const setup = await arrange();
  const first = newCustomer("Firsty");
  const second = newCustomer("Secondly");
  const third = newCustomer("Thirdly");
  try {
    await openTimetable(page);
    const row = page.getByRole("listitem").filter({ hasText: setup.className });
    await expect(page.getByRole("heading", { name: /^Tomorrow/ })).toBeVisible();
    await expect(row).toContainText("Dr Arjun Shah");
    await expect(row).toContainText("2 left");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectAccessible(page, testInfo, "class timetable");

    const firstLink = await takeSeat(page, setup, first, "Book a seat", "Book my seat", "You’re booked");
    await expect(row).toContainText("1 left");
    await takeSeat(page, setup, second, "Book a seat", "Book my seat", "You’re booked");
    await expect(row).toContainText("Full: join the waiting list");
    await expect(row.getByRole("button", { name: /Book a seat/ })).toHaveCount(0);

    const thirdLink = await takeSeat(page, setup, third, "Join waiting list", "Join the waiting list", "You’re number 1 on the waiting list");

    // Before anyone cancels, the third sees their place in line and no offer.
    await page.goto(thirdLink);
    await expect(page.getByRole("heading", { level: 1, name: "You’re number 1 on the waiting list" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Take this seat" })).toHaveCount(0);

    // The first cancels from their own link, after a confirm step.
    await page.goto(firstLink);
    await expect(page.getByRole("heading", { level: 1, name: "You have a seat" })).toBeVisible();
    await expectAccessible(page, testInfo, "seat page");
    await page.getByRole("button", { name: "Cancel my place" }).click();
    await page.getByRole("button", { name: "Yes, cancel my place" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Your place is cancelled" })).toBeVisible();

    // The freed seat is held for the third, who takes it from a small phone.
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(thirdLink);
    await expect(page.getByRole("heading", { level: 1, name: "A seat opened up" })).toBeVisible();
    await expect(page.getByRole("timer")).toContainText(/\d+:\d{2}/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectAccessible(page, testInfo, "seat offer");
    if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/class-offer-360-${testInfo.project.name}.png` });
    await page.getByRole("button", { name: "Take this seat" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "You have a seat" })).toBeVisible();

    // The timetable shows the class full again.
    await openTimetable(page);
    await expect(page.getByRole("listitem").filter({ hasText: setup.className })).toContainText("Full: join the waiting list");
  } finally {
    await restore(setup, [first, second, third]);
  }
});
