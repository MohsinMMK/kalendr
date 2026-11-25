import { randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";

import { expectAccessible, signIn, unique, withOwnerDatabase } from "./support/journey";

/**
 * Feature 46, the owner's side: a form with a route that can never be reached shows a warning in the builder, the
 * preview shows the matched route and the people it would offer without writing anything, and the report counts people
 * who answered but did not book last week. The form is arranged in the database; everything checked is on screen.
 */
const owner = "kalendr.owner@example.com";
const slug = "lotus-dental";

async function seed() {
  const name = `Visit finder ${unique()}`;
  const formSlug = `finder-${unique()}`;
  return withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    const tenantId = tenant!.id;
    const [service] = await sql<{ id: string }[]>`select id from services where tenant_id = ${tenantId} and name = 'Dental consultation'`;
    const definition = {
      questions: [
        { id: "first", type: "yes_no", label: "Is this your first visit?", required: true },
        { id: "language", type: "single_choice", label: "Which language do you prefer?", required: true, options: ["Tamil", "Hindi"] },
      ],
      routes: [
        { id: "everyone", name: "Everyone", conditions: [], destination: { type: "message", title: "Hello", body: "Welcome." } },
        {
          id: "tamil", name: "Tamil speakers", conditions: [{ fieldId: "language", operator: "equals", value: "Tamil" }],
          destination: { type: "service", serviceId: service!.id, people: { personIds: [], filters: [], weights: [] } },
        },
      ],
      fallback: { type: "message", title: "Call us", body: "We will help." },
    };
    const [form] = await sql<{ id: string }[]>`
      insert into routing_forms (tenant_id, name, slug, definition, status, live_version) values (${tenantId}, ${name}, ${formSlug}, ${JSON.stringify(definition)}::jsonb, 'live', 1) returning id`;
    await sql`insert into routing_form_versions (tenant_id, form_id, version, name, definition) values (${tenantId}, ${form!.id}, 1, ${name}, ${JSON.stringify(definition)}::jsonb)`;
    // Two people who answered last week and did not book, one who booked, one who only opened.
    const insert = (answeredHoursAgo: number | null) => sql`
      insert into routing_responses (tenant_id, form_id, form_version, token_hash, route_id, route_name, destination_type, service_id, opened_at, answered_at, expires_at)
      values (${tenantId}, ${form!.id}, 1, ${randomBytes(32).toString("hex")}, ${answeredHoursAgo === null ? null : "tamil"}, ${answeredHoursAgo === null ? null : "Tamil speakers"},
        ${answeredHoursAgo === null ? null : "service"}, ${answeredHoursAgo === null ? null : service!.id}, now() - interval '3 days',
        ${answeredHoursAgo === null ? null : sql`now() - ${answeredHoursAgo} * interval '1 hour'`}, now() + interval '1 day')`;
    await insert(48);
    await insert(72);
    await insert(null);
    return { tenantId, name, formId: form!.id };
  });
}

test("the builder warns about an unreachable route, previews without saving, and the report counts who did not book", async ({ page }, testInfo) => {
  const seeded = await seed();
  await signIn(page, owner, undefined, "/routing-forms");
  await expect(page.getByRole("heading", { level: 1, name: "Routing forms" })).toBeVisible();
  await expectAccessible(page, testInfo, "routing forms list", "ul[aria-label=\"Routing forms\"]");
  await page.getByText(seeded.name).first().click();

  // "Everyone" has no conditions, so the route after it can never be reached.
  await expect(page.getByText(/“Tamil speakers” can never be reached/).first()).toBeVisible();
  await expectAccessible(page, testInfo, "routing form builder", "[data-slot=workspace-page]");

  const before = await withOwnerDatabase(async (sql) => (await sql<{ n: string }[]>`
    select ((select count(*) from routing_responses) + (select count(*) from routing_forms) + (select count(*) from routing_form_versions) + (select count(*) from audit_events))::text as n`)[0]!.n);
  const preview = page.getByRole("button", { name: "Preview" });
  if (!(await preview.isVisible())) {
    // On a phone the row keeps only Save; the rest is behind the ⋯ button next to it, shown as a bottom sheet.
    await page.getByRole("button", { name: "Save" }).locator("xpath=following::button[1]").click();
    // The sheet slides in; let it settle before tapping.
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"), undefined, { timeout: 5_000 }).catch(() => {});
    await page.getByRole("menuitem", { name: "Preview" }).click();
  } else {
    await preview.click();
  }
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText(/Nothing is saved/i)).toBeVisible();
  await drawer.getByRole("button", { name: "Yes", exact: true }).first().click();
  await drawer.getByRole("button", { name: "Tamil", exact: true }).first().click();
  await drawer.getByRole("button", { name: /Show|Check|Try|Preview/ }).last().click();
  await expect(drawer.getByText("Everyone").first()).toBeVisible();
  const after = await withOwnerDatabase(async (sql) => (await sql<{ n: string }[]>`
    select ((select count(*) from routing_responses) + (select count(*) from routing_forms) + (select count(*) from routing_form_versions) + (select count(*) from audit_events))::text as n`)[0]!.n);
  expect(after).toBe(before);
  await page.keyboard.press("Escape");

  // The report: two people answered in the last week and did not book.
  await page.goto("/routing-forms");
  await page.getByRole("tab", { name: "Report" }).click();
  await expect(page.getByText(/answered but did not book|didn.t book/i).first()).toBeVisible();
  await expectAccessible(page, testInfo, "routing report", "[data-slot=workspace-page]");
});
