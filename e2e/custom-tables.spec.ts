import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";

import { expectAccessible, newPage, signIn, unique, withOwnerDatabase } from "./support/journey";

const slug = "lotus-dental";
const owner = "kalendr.owner@example.com";

/** A layout save is debounced; wait for the PUT so a reload sees it. */
function layoutSaved(page: Page) {
  return page.waitForResponse((response) => response.url().includes("/api/staff/workspace-layout") && response.request().method() === "PUT" && response.ok());
}

async function resetLayout(): Promise<void> {
  await withOwnerDatabase((sql) => sql`update tenants set layout = '{}'::jsonb where slug = ${slug}`);
}

async function seedCustomer(label: string): Promise<{ id: string; name: string }> {
  const suffix = randomUUID().slice(0, 6);
  const firstName = `Zz${label}`;
  const lastName = `Grid${suffix}`;
  const id = await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    const [patient] = await sql<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${tenant!.id}, ${firstName}, ${lastName}, ${`+9198${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`}, ${`${firstName}.${lastName}@example.com`.toLowerCase()}, 'email') returning id`;
    return patient!.id;
  });
  return { id, name: `${firstName} ${lastName}` };
}

const header = (page: Page, name: string | RegExp) => page.getByRole("columnheader").getByRole("button", { name, exact: typeof name === "string" });
const headerOrder = (page: Page) => page.getByRole("columnheader").evaluateAll((cells) => cells.map((cell) => (cell.textContent ?? "").trim()).filter(Boolean));

test("the owner renames, hides, moves and adds columns on Customers, edits a cell, and it all survives a reload; a receptionist sees the same table without the controls", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The table headers are for wider screens; a phone shows cards (the last journey covers them).");
  await resetLayout();
  const customer = await seedCustomer("Tbl");
  const fieldName = `Tier ${unique()}`;
  await signIn(page, owner, undefined, "/patients");
  await page.getByRole("searchbox", { name: /Search/ }).fill(customer.name);
  await expect(page.getByRole("button", { name: customer.name, exact: true })).toBeVisible();

  // Rename Phone, inline in the header.
  await header(page, "Phone").click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  let saved = layoutSaved(page);
  const rename = page.getByRole("textbox", { name: "Name of the Phone column" });
  await rename.fill("Mobile");
  await rename.press("Enter");
  await saved;
  await expect(header(page, "Mobile")).toBeVisible();

  // Hide Preferred contact.
  await header(page, "Preferred contact").click();
  saved = layoutSaved(page);
  await page.getByRole("menuitem", { name: "Hide" }).click();
  await saved;
  await expect(header(page, "Preferred contact")).toHaveCount(0);

  // Move Next booking one place left, which puts it before Mobile.
  await header(page, "Next booking").click();
  saved = layoutSaved(page);
  await page.getByRole("menuitem", { name: "Move left" }).click();
  await saved;
  expect((await headerOrder(page)).slice(0, 3)).toEqual(["Patient", "Next booking", "Mobile"]);

  // Dragging a header onto another moves it there, and dragging it back puts it back.
  saved = layoutSaved(page);
  await page.locator(`[data-column-id="phone"] [data-drag-handle]`).dragTo(header(page, "Next booking"));
  await saved;
  expect((await headerOrder(page)).slice(0, 3)).toEqual(["Patient", "Mobile", "Next booking"]);
  saved = layoutSaved(page);
  await page.locator(`[data-column-id="next"] [data-drag-handle]`).dragTo(header(page, "Mobile"));
  await saved;
  expect((await headerOrder(page)).slice(0, 3)).toEqual(["Patient", "Next booking", "Mobile"]);

  // Dragging a column's edge resizes it, and the width is kept for the business.
  const phoneHeader = page.getByRole("columnheader", { name: "Mobile" });
  const widthBefore = (await phoneHeader.boundingBox())!.width;
  const edge = (await phoneHeader.locator('[data-slot="data-grid-table-resize-handle"]').boundingBox())!;
  saved = layoutSaved(page);
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 90, edge.y + edge.height / 2, { steps: 8 });
  await page.mouse.up();
  await saved;
  const widthAfter = (await phoneHeader.boundingBox())!.width;
  expect(widthAfter).toBeGreaterThan(widthBefore + 40);

  // Filter from a header adds that column to the filter bar.
  await header(page, "Mobile").click();
  await page.getByRole("menuitem", { name: "Filter" }).click();
  await expect(page.getByText("Select condition")).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();

  // The system fields cannot be deleted, and the menu says so.
  await header(page, "Patient").click();
  await expect(page.getByRole("menuitem", { name: /Can't be deleted/ })).toBeDisabled();
  await expectAccessible(page, testInfo, "customers column menu");
  await page.keyboard.press("Escape");

  // Add a choice field from the + at the end of the header.
  await page.getByRole("button", { name: "Add a field" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a field" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(fieldName);
  await dialog.getByRole("combobox", { name: /Kind/ }).click();
  await page.getByRole("option", { name: "Choice", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Choice 1" }).fill("Gold");
  await dialog.getByRole("textbox", { name: "Choice 2" }).fill("Silver");
  await dialog.getByRole("button", { name: "Add field" }).click();
  await expect(header(page, fieldName)).toBeVisible();

  // Set its value in the cell.
  await page.getByRole("button", { name: `${fieldName} for ${customer.name}` }).click();
  const answerSaved = page.waitForResponse((response) => response.url().includes(`/customers/${customer.id}/fields`) && response.request().method() === "PUT" && response.ok());
  await page.getByRole("menuitemradio", { name: "Gold" }).click();
  await answerSaved;
  await expect(page.getByRole("button", { name: `${fieldName} for ${customer.name}` })).toContainText("Gold");

  // Everything persists.
  await page.reload();
  await page.getByRole("searchbox", { name: /Search/ }).fill(customer.name);
  await expect(header(page, "Mobile")).toBeVisible();
  await expect(header(page, "Preferred contact")).toHaveCount(0);
  expect((await headerOrder(page)).slice(0, 3)).toEqual(["Patient", "Next booking", "Mobile"]);
  expect((await page.getByRole("columnheader", { name: "Mobile" }).boundingBox())!.width).toBeGreaterThan(widthBefore + 40);
  await expect(page.getByRole("button", { name: `${fieldName} for ${customer.name}` })).toContainText("Gold");

  // Filled cells, including a link (which sits beside its button, never inside it), pass the accessibility scan.
  const site = await page.request.post("/api/staff/customer-fields", { data: { label: `Site ${unique()}`, kind: "link" } });
  const siteField = (await site.json()).data as { id: string; version: number; label: string };
  const filled = await page.request.put(`/api/staff/customers/${customer.id}/fields`, { data: { values: { [siteField.id]: "example.com/menu" } } });
  expect(filled.ok()).toBe(true);
  const plans = await page.request.post("/api/staff/customer-fields", { data: { label: `Plans ${unique()}`, kind: "multichoice", choices: ["Yoga", "Spin", "Pilates"] } });
  const plansField = (await plans.json()).data as { id: string; version: number; label: string };
  await page.reload();
  await page.getByRole("searchbox", { name: /Search/ }).fill(customer.name);
  await expect(page.getByRole("link", { name: `Open ${siteField.label} for ${customer.name}` })).toHaveAttribute("href", "https://example.com/menu");
  // Ticking two options in one open menu: the first save must not close the menu or lose the second tick.
  await page.getByRole("button", { name: new RegExp(`^${plansField.label} for ${customer.name}`) }).click();
  await page.getByRole("menuitemcheckbox", { name: "Yoga" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Spin" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Spin" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemcheckbox", { name: "Yoga" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: new RegExp(`^${plansField.label} for ${customer.name}: Yoga Spin`) })).toBeVisible();
  await expectAccessible(page, testInfo, "customers table with answers");
  await page.request.patch(`/api/staff/customer-fields/${siteField.id}`, { data: { archived: true, version: siteField.version } });
  await page.request.patch(`/api/staff/customer-fields/${plansField.id}`, { data: { archived: true, version: plansField.version } });

  // A receptionist sees the owner's table, can fill a cell in, and has no way to change the columns or fields.
  const email = `desk.${unique()}@example.com`;
  const password = `Pw-${randomUUID()}`;
  const userId = randomUUID();
  await withOwnerDatabase(async (sql) => {
    const [business] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    await sql`insert into auth_users (id, name, email, email_verified, password_set_at) values (${userId}, 'Dev Desk', ${email}, true, now())`;
    await sql`insert into auth_accounts (id, issuer, account_id, provider_id, user_id, password) values (${randomUUID()}, 'local:credential', ${userId}, 'credential', ${userId}, ${await hashPassword(password)})`;
    await sql`insert into memberships (tenant_id, user_id, role) values (${business!.id}, ${userId}, 'receptionist')`;
  });
  try {
    const desk = await newPage(browser, testInfo);
    await signIn(desk, email, password, "/patients");
    await desk.getByRole("searchbox", { name: /Search/ }).fill(customer.name);
    await expect(header(desk, "Mobile")).toBeVisible();
    await expect(header(desk, "Preferred contact")).toHaveCount(0);
    expect((await headerOrder(desk)).slice(0, 3)).toEqual(["Patient", "Next booking", "Mobile"]);
    await expect(desk.getByRole("button", { name: "Add a field" })).toHaveCount(0);
    await expect(desk.getByRole("button", { name: "Columns" })).toHaveCount(0);
    await expect(desk.getByRole("button", { name: `${fieldName} for ${customer.name}` })).toContainText("Gold");
    await header(desk, fieldName).click();
    await expect(desk.getByRole("menuitem", { name: "Sort ascending" })).toBeVisible();
    await expect(desk.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
    await expect(desk.getByRole("menuitem", { name: "Delete field" })).toHaveCount(0);
    await expect(desk.getByRole("menuitem", { name: "Hide" })).toHaveCount(0);
    await desk.keyboard.press("Escape");
    // The server refuses them as well as the screen.
    const refused = await desk.request.post("/api/staff/customer-fields", { data: { label: "Nope", kind: "text" } });
    expect(refused.status()).toBe(403);
    await desk.context().close();
  } finally {
    await withOwnerDatabase(async (sql) => {
      await sql`delete from memberships where user_id = ${userId}`;
      await sql`delete from auth_sessions where user_id = ${userId}`;
      await sql`delete from auth_accounts where user_id = ${userId}`;
      await sql`delete from auth_users where id = ${userId}`;
    });
  }

  // Back as the owner: bring the defaults back with Reset columns, then delete the field after confirming.
  await page.getByRole("button", { name: "Columns" }).click();
  saved = layoutSaved(page);
  await page.getByRole("menuitem", { name: "Reset columns" }).click();
  await saved;
  await page.keyboard.press("Escape");
  await expect(header(page, "Phone")).toBeVisible();
  await expect(header(page, "Preferred contact")).toBeVisible();
  expect((await headerOrder(page)).slice(0, 3)).toEqual(["Patient", "Phone", "Preferred contact"]);

  await header(page, fieldName).click();
  await page.getByRole("menuitem", { name: "Delete field" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(`Delete the ${fieldName} field?`);
  await confirm.getByRole("button", { name: "Delete field" }).click();
  await expect(header(page, fieldName)).toHaveCount(0);
  await page.reload();
  await expect(header(page, fieldName)).toHaveCount(0);
});

/** Renames a column inline from its header menu and waits for the business's layout to save. */
async function renameColumn(page: Page, from: string, to: string) {
  await header(page, from).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const saved = layoutSaved(page);
  const input = page.getByRole("textbox", { name: `Name of the ${from} column` });
  await input.fill(to);
  await input.press("Enter");
  await saved;
}

async function hideColumn(page: Page, name: string) {
  await header(page, name).click();
  const saved = layoutSaved(page);
  await page.getByRole("menuitem", { name: "Hide" }).click();
  await saved;
}

async function resetColumns(page: Page) {
  await page.getByRole("button", { name: "Columns" }).click();
  const saved = layoutSaved(page);
  await page.getByRole("menuitem", { name: "Reset columns" }).click();
  await saved;
  await page.keyboard.press("Escape");
}

test("the same rename, hide and reset work on Bookings and on Records", async ({ page }) => {
  test.skip(test.info().project.name === "phone", "The table headers are for wider screens; a phone shows cards (the last journey covers them).");
  await resetLayout();
  const customer = await seedCustomer("Both");
  await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    const [location] = await sql<{ id: string }[]>`select id from locations where tenant_id = ${tenant!.id} limit 1`;
    const [service] = await sql<{ id: string }[]>`select id from services where tenant_id = ${tenant!.id} limit 1`;
    const [practitioner] = await sql<{ id: string }[]>`select id from practitioners where tenant_id = ${tenant!.id} limit 1`;
    await sql`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor)
      values (${tenant!.id}, ${location!.id}, ${customer.id}, ${practitioner!.id}, ${service!.id}, now() + interval '2 days', now() + interval '2 days 30 minutes',
        'booked', 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, 50000)`;
  });
  await signIn(page, owner, undefined, "/bookings");
  await expect(header(page, "Time")).toBeVisible();

  // Bookings: rename, hide, show a hidden one, and reset; it all survives a reload.
  await renameColumn(page, "Service", "Treatment");
  await expect(header(page, "Treatment")).toBeVisible();
  await hideColumn(page, "Booked via");
  await expect(header(page, "Booked via")).toHaveCount(0);
  await page.reload();
  await expect(header(page, "Treatment")).toBeVisible();
  await expect(header(page, "Booked via")).toHaveCount(0);
  await page.getByRole("button", { name: "Columns" }).click();
  const shownSaved = layoutSaved(page);
  await page.getByRole("menuitemcheckbox", { name: "Branch" }).click();
  await shownSaved;
  await page.keyboard.press("Escape");
  await expect(header(page, "Branch")).toBeVisible();
  // Filter from a header opens the one Filter menu.
  await header(page, "Branch").click();
  await page.getByRole("menuitem", { name: "Filter" }).click();
  await expect(page.getByRole("textbox", { name: /Search .* by name or phone/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await resetColumns(page);
  await expect(header(page, "Service")).toBeVisible();
  await expect(header(page, "Booked via")).toBeVisible();
  await expect(header(page, "Branch")).toHaveCount(0);

  // A saved view's columns (held in the address) replace the business's for this screen; Reset goes back.
  await page.goto("/bookings?columns=time,customer,price");
  await expect(header(page, "Price")).toBeVisible();
  await expect(header(page, "Service")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("saved-view-columns.png") });
  await page.getByRole("button", { name: "Columns" }).click();
  await page.getByRole("menuitem", { name: "Reset columns" }).click();
  await expect(header(page, "Service")).toBeVisible();
  await expect(header(page, "Price")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("columns")).toBeNull();

  // Records: the same menu.
  const created = await page.request.post("/api/staff/records", { data: { patientId: customer.id, appointmentId: null, kind: "note", title: `Grid note ${unique()}`, body: "Checked." } });
  expect(created.ok()).toBe(true);
  await page.goto(`/records?patient=${customer.id}`);
  await expect(header(page, "Document")).toBeVisible();
  await renameColumn(page, "Document", "File");
  await hideColumn(page, "Status");
  await page.reload();
  await expect(header(page, "File")).toBeVisible();
  await expect(header(page, "Status")).toHaveCount(0);
  await resetColumns(page);
  await expect(header(page, "Document")).toBeVisible();
  await expect(header(page, "Status")).toBeVisible();
});

test("a column the owner hid stays hidden on a phone, and the cards still read well", async ({ page }) => {
  test.skip(test.info().project.name === "phone", "It hides the column on a wide screen first, then looks at the phone-width cards.");
  await resetLayout();
  const customer = await seedCustomer("Phone");
  const phone = (await withOwnerDatabase((sql) => sql<{ phone: string }[]>`select phone from patients where id = ${customer.id}`))[0]!.phone;
  await signIn(page, owner, undefined, "/patients");
  await page.getByRole("searchbox", { name: /Search/ }).fill(customer.name);
  await expect(page.getByText(phone)).toBeVisible();
  await hideColumn(page, "Phone");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  await page.getByRole("searchbox", { name: /Search/ }).fill(customer.name);
  await expect(page.getByText(customer.name, { exact: true })).toBeVisible();
  await expect(page.getByText(phone)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await resetLayout();
  await page.reload();
  await page.getByRole("searchbox", { name: /Search/ }).fill(customer.name);
  await expect(page.getByText(phone)).toBeVisible();
});
