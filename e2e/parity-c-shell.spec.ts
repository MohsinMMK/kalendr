import { expect, test, type Page } from "@playwright/test";

import { expectAccessible, signIn, unique, withOwnerDatabase } from "./support/journey";

/**
 * Cal.com parity wave, lane C: the booking link pinned in the sidebar, starter prompts in the copilot, templates on an empty
 * Routing forms page, the two-tab time-off screen with what a booker will see, and the owner's summary choice. Screenshots at
 * 375 and 1440 wide go to docs/verification/2026-11-25-parity-c-shell/.
 */
const owner = "kalendr.owner@example.com";
const slug = "lotus-dental";
const shots = "docs/verification/2026-11-25-parity-c-shell";

test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 181 : 81}` });
});

async function shoot(page: Page, name: string): Promise<void> {
  for (const [label, width, height] of [["375", 375, 812], ["1440", 1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/${name}-${label}.png`, fullPage: false });
  }
}

test("the booking link is pinned in the sidebar and copies the business's own address", async ({ page, context, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The sidebar is a drawer on a phone; the desktop run covers the pin.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, owner, undefined, "/dashboard");
  const pin = page.getByTestId("booking-link-pin");
  await expect(pin).toBeVisible();
  await expect(pin.getByRole("link", { name: /^Open.*booking page in a new tab/ })).toHaveAttribute("href", `/book/${slug}`);
  await pin.getByRole("button", { name: /^Cop.*booking link/ }).click();
  await expect(page.getByText("Booking link copied").first()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${baseURL}/book/${slug}`);
  await expectAccessible(page, testInfo, "sidebar with the booking link");
  await shoot(page, "sidebar-booking-link");
});

test("a new copilot chat shows four starter prompts, and clicking one sends it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Same screen on desktop and phone; the desktop run covers it.");
  await signIn(page, owner, undefined, "/dashboard");
  await page.getByRole("button", { name: "Open the copilot" }).click();
  const copilot = page.getByRole("dialog", { name: "Copilot" });
  const prompts = copilot.getByRole("group", { name: "Suggested questions" }).getByRole("button");
  await expect(prompts).toHaveCount(4);
  await shoot(page, "copilot-prompts");
  await page.setViewportSize({ width: 1366, height: 900 });
  await prompts.first().click();
  await expect(copilot.getByText("Who is booked tomorrow?").first()).toBeVisible();
  await expect(copilot.getByRole("group", { name: "Suggested questions" })).toBeHidden();
});

test("an empty Routing forms page offers three templates, and one creates an editable draft", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Same screen on desktop and phone; the desktop run covers it.");
  await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    await sql`delete from routing_responses where tenant_id = ${tenant!.id}`;
    await sql`delete from routing_form_versions where tenant_id = ${tenant!.id}`;
    await sql`delete from routing_forms where tenant_id = ${tenant!.id}`;
  });
  await signIn(page, owner, undefined, "/routing-forms");
  await expect(page.getByRole("heading", { name: "Start from a template" })).toBeVisible();
  await shoot(page, "routing-templates");
  await page.setViewportSize({ width: 1366, height: 900 });
  await expectAccessible(page, testInfo, "routing forms, empty with templates");
  await page.getByRole("button", { name: /New or returning/ }).click();
  await expect(page.getByText(/Draft|draft/).first()).toBeVisible();
  const drafts = await withOwnerDatabase((sql) => sql<{ status: string; name: string }[]>`
    select status, name from routing_forms where tenant_id = (select id from tenants where slug = ${slug})`);
  expect(drafts).toHaveLength(1);
  expect(drafts[0]!.status).toBe("draft");
  expect(drafts[0]!.name).toMatch(/New or returning/);
});

test("time off has My time off and Holidays tabs, and shows a booker what they will see", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Same screen on desktop and phone; the desktop run covers it.");
  const note = `Back soon ${unique()}`;
  await signIn(page, owner, undefined, "/dashboard");
  const practitioners = await withOwnerDatabase((sql) => sql<{ id: string; name: string }[]>`
    select id, name from practitioners where is_active and tenant_id = (select id from tenants where slug = ${slug}) order by name limit 2`);
  expect(practitioners.length).toBe(2);
  const away = practitioners[0]!;
  const cover = practitioners[1]!;
  const day = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  const created = await page.request.post("/api/staff/availability/time-off", {
    data: { practitionerId: away.id, startsOn: day, throughDate: day, reason: "leave", publicNote: note, coverPractitionerId: cover.id },
  });
  expect(created.status()).toBe(201);
  try {
    await page.goto("/settings");
    await page.getByText("Hours", { exact: true }).first().click();
    await expect(page.getByRole("tab", { name: /time off/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Holidays" })).toBeVisible();
    const view = page.getByTestId("booker-view").filter({ hasText: note });
    await expect(view).toBeVisible();
    await expect(view).toContainText(`Shows ${cover.name}'s times`);
    await shoot(page, "time-off");
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.getByRole("tab", { name: "Holidays" }).click();
    await expect(page.getByRole("heading", { name: /holiday/i }).first()).toBeVisible();
  } finally {
    await withOwnerDatabase((sql) => sql`delete from time_off where practitioner_id = ${away.id} and public_note = ${note}`);
  }
});

test("an owner chooses the summary email, and turning it off stays off", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Same screen on desktop and phone; the desktop run covers it.");
  const reset = () => withOwnerDatabase((sql) => sql`
    update memberships set summary_frequency = null, summary_sent_for = null
    where role = 'owner' and tenant_id = (select id from tenants where slug = ${slug})`);
  await reset();
  try {
    await signIn(page, owner, undefined, "/profile");
    await page.getByRole("link", { name: "Open notifications" }).click();
    const choice = page.getByRole("combobox", { name: "Summary of your business by email" });
    await expect(choice).toContainText("Every week");
    await choice.click();
    await page.getByRole("option", { name: "Off" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Summary of your business by email" })).toContainText("Off");
    await shoot(page, "summary-choice");
    const [stored] = await withOwnerDatabase((sql) => sql<{ summary_frequency: string | null }[]>`
      select summary_frequency from memberships where role = 'owner' and tenant_id = (select id from tenants where slug = ${slug})`);
    expect(stored!.summary_frequency).toBe("off");
  } finally {
    await reset();
  }
});
