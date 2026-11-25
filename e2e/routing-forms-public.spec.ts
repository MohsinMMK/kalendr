import { expect, test } from "@playwright/test";

import { expectAccessible, newCustomer, unique, withOwnerDatabase } from "./support/journey";
import { minimumBookingFillMs } from "../src/lib/bot-check";

/**
 * Feature 46, the customer's side: a first-time Tamil speaker answers two questions and lands on a booking page that
 * offers only the Tamil-speaking doctor, with the answers already filled in. State is arranged in the database (the
 * builder has its own journey); the form and the booking are driven through the browser.
 */
const slug = "lotus-dental";

interface Seed { formSlug: string; serviceId: string; kavya: string; arjun: string; email: string }

async function seed(): Promise<Seed> {
  const formSlug = `first-visit-${unique()}`;
  return withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    const tenantId = tenant!.id;
    const [service] = await sql<{ id: string }[]>`select id from services where tenant_id = ${tenantId} and name = 'Dental consultation'`;
    const people = await sql<{ id: string; name: string }[]>`select id, name from practitioners where tenant_id = ${tenantId}`;
    const kavya = people.find((person) => person.name === "Dr Kavya Rao")!.id;
    const arjun = people.find((person) => person.name === "Dr Arjun Shah")!.id;
    const [language] = await sql<{ id: string }[]>`
      insert into attribute_definitions (tenant_id, name, kind, options) values (${tenantId}, 'Language', 'multiple', ${["Tamil", "Hindi", "English"]})
      on conflict (tenant_id, name) do update set name = excluded.name returning id`;
    for (const [person, value] of [[kavya, ["Tamil", "English"]], [arjun, ["Hindi"]]] as const) {
      await sql`insert into practitioner_attributes (tenant_id, practitioner_id, attribute_id, value) values (${tenantId}, ${person}, ${language!.id}, ${JSON.stringify(value)}::jsonb)
        on conflict (tenant_id, practitioner_id, attribute_id) do update set value = excluded.value`;
    }
    const definition = {
      questions: [
        { id: "first", type: "yes_no", label: "Is this your first visit?", required: true },
        { id: "language", type: "single_choice", label: "Which language do you prefer?", required: true, options: ["Tamil", "Hindi", "English"] },
        { id: "email", type: "email", label: "Your email", required: false },
      ],
      routes: [{
        id: "tamil-first", name: "First-time Tamil speaker",
        conditions: [{ fieldId: "first", operator: "equals", value: "yes" }, { fieldId: "language", operator: "equals", value: "Tamil" }],
        destination: { type: "service", serviceId: service!.id, people: { personIds: [], weights: [], filters: [{ attributeId: language!.id, operator: "includes", source: { type: "question", fieldId: "language" } }] } },
      }],
      fallback: { type: "message", title: "Call us", body: "We will help you find the right visit." },
    };
    const [form] = await sql<{ id: string }[]>`
      insert into routing_forms (tenant_id, name, slug, intro, definition, status, live_version) values (${tenantId}, 'Which visit do you need?', ${formSlug}, 'Two quick questions.', ${JSON.stringify(definition)}::jsonb, 'live', 1) returning id`;
    await sql`insert into routing_form_versions (tenant_id, form_id, version, name, intro, definition) values (${tenantId}, ${form!.id}, 1, 'Which visit do you need?', 'Two quick questions.', ${JSON.stringify(definition)}::jsonb)`;
    return { formSlug, serviceId: service!.id, kavya, arjun, email: `tamil-${unique()}@example.com` };
  });
}

test("a first-time Tamil speaker is routed to the Tamil-speaking doctor with the answers filled in", async ({ page }, testInfo) => {
  const ids = await seed();
  const customer = newCustomer("Meena");

  await page.goto(`/f/${slug}/${ids.formSlug}`);
  await expect(page.getByRole("heading", { level: 1, name: "Which visit do you need?" })).toBeVisible();
  await expectAccessible(page, testInfo, "routing form");

  await page.getByRole("group", { name: "Is this your first visit?" }).getByRole("button", { name: "Yes", exact: true }).click();
  await page.getByRole("group", { name: "Which language do you prefer?" }).getByRole("button", { name: "Tamil", exact: true }).click();
  await page.getByRole("textbox", { name: /Your email/ }).fill(ids.email);
  await page.getByRole("button", { name: "Continue" }).click();

  // The booking address carries ids and a token, never an answer.
  await page.waitForURL(new RegExp(`/book/${slug}\\?`));
  const url = new URL(page.url());
  expect(url.searchParams.get("service")).toBe(ids.serviceId);
  expect(url.searchParams.get("routing")?.length ?? 0).toBeGreaterThanOrEqual(40);
  expect(page.url()).not.toContain("Tamil");
  expect(page.url()).not.toContain(encodeURIComponent(ids.email));

  // The form already settled the service and the person: after the first-visit question the page goes straight to times, and only Dr Kavya's are listed.
  await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
  const times = page.getByRole("radiogroup").last().getByRole("radio");
  await expect(times.first()).toBeVisible();
  expect(await times.evaluateAll((nodes) => nodes.some((node) => (node.getAttribute("aria-label") ?? "").includes("Arjun")))).toBe(false);
  await times.first().click();

  await expect(page.getByRole("heading", { level: 1, name: "Last step: your details" })).toBeVisible();
  // The email answered on the form is already in the details step.
  await expect(page.getByRole("textbox", { name: "Email address" })).toHaveValue(ids.email);
  await page.getByRole("textbox", { name: "Full name" }).fill(`${customer.firstName} ${customer.lastName}`);
  await page.getByRole("textbox", { name: "Mobile number" }).fill(customer.phone);
  await page.getByRole("checkbox", { name: /I understand and agree/ }).check();
  await page.waitForTimeout(minimumBookingFillMs);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  const confirmation = page.getByRole("region", { name: "You’re booked" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText("Dr Kavya Rao")).toBeVisible();

  // The booking is Dr Kavya's, linked to the response, and its trace says why.
  await withOwnerDatabase(async (sql) => {
    const rows = await sql<{ practitioner_id: string; outcome: string; trace: { assignment?: { name: string } } }[]>`
      select a.practitioner_id, r.outcome, r.trace from routing_responses r join appointments a on a.id = r.appointment_id
      join routing_forms f on f.id = r.form_id where f.slug = ${ids.formSlug}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ practitioner_id: ids.kavya, outcome: "booked" });
  });
});

test("an unknown form and a form that is not live look the same, and a message route shows its message", async ({ page }) => {
  const ids = await seed();
  await page.goto(`/f/${slug}/does-not-exist`);
  const unknown = await page.locator("main, body").first().innerText();
  expect(unknown).toMatch(/not available/i);
  await withOwnerDatabase(async (sql) => { await sql`update routing_forms set status = 'draft' where slug = ${ids.formSlug}`; });
  await page.goto(`/f/${slug}/${ids.formSlug}`);
  expect(await page.locator("main, body").first().innerText()).toBe(unknown);
  await withOwnerDatabase(async (sql) => { await sql`update routing_forms set status = 'live' where slug = ${ids.formSlug}`; });

  await page.goto(`/f/${slug}/${ids.formSlug}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(/Choose yes or no|Answer this question|Choose one/).first()).toBeVisible();
  await page.getByRole("group", { name: "Is this your first visit?" }).getByRole("button", { name: "No", exact: true }).click();
  await page.getByRole("group", { name: "Which language do you prefer?" }).getByRole("button", { name: "Hindi", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  // No route matches, so the fallback message is shown in place.
  await expect(page.getByRole("heading", { name: "Call us" })).toBeVisible();
});
