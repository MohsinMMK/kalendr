import { expect, test, type Page } from "@playwright/test";

import { expectAccessible, signIn, withOwnerDatabase } from "./support/journey";

/**
 * Feature 14: Settings → Plan and billing as the owner, and the upgrade prompt when the server refuses something the plan
 * does not allow. No payment provider keys are set in the browser tests, so the honest state here is "payments are not
 * connected yet"; the checkout branches (Razorpay sheet, Stripe redirect) are covered by component tests with fakes.
 */
const owner = "kalendr.owner@example.com";
const tenantSlug = "lotus-dental";

async function setSubscription(plan: { key: string; status: string; trialDays?: number }): Promise<void> {
  await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${tenantSlug}`;
    // Nine days and a bit, so "9 days left" holds whatever time of day the test runs.
    const trialEnd = plan.trialDays ? sql`now() + (${plan.trialDays}::int * interval '1 day') - interval '1 hour'` : sql`null`;
    await sql`
      insert into tenant_subscriptions (tenant_id, plan_key, status, trial_ends_at)
      values (${tenant!.id}, ${plan.key}, ${plan.status}, ${trialEnd})
      on conflict (tenant_id) do update
         set plan_key = excluded.plan_key, status = excluded.status, trial_ends_at = excluded.trial_ends_at, cancel_at_period_end = false,
             pending_plan_key = null, past_due_since = null, provider = null, provider_subscription_id = null`;
  });
}

async function openBilling(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Plan and billing" }).click();
  await expect(page.getByRole("heading", { name: "Plan and billing", level: 2 })).toBeVisible();
}

test("the owner of a trial business sees the trial, compares plans and finds checkout not connected", async ({ page }, testInfo) => {
  await setSubscription({ key: "growth", status: "trialing", trialDays: 9 });
  await signIn(page, owner);
  await openBilling(page);

  await expect(page.getByText("Growth trial, 9 days left, no card needed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Compare plans" })).toBeVisible();
  for (const name of ["Free", "Starter", "Growth", "Scale"]) await expect(page.getByRole("heading", { name, level: 4 })).toBeVisible();
  await expect(page.getByText("Payments for plans aren't connected yet")).toBeVisible();
  const starter = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Starter", level: 4 }) });
  await expect(starter.getByRole("button")).toBeDisabled();
  await expectAccessible(page, testInfo, "plans");

  await page.getByRole("tab", { name: "Usage" }).click();
  await expect(page.getByText("Appointment confirmations and reminders are never stopped.")).toBeVisible();
  await page.getByRole("tab", { name: "Invoices" }).click();
  await expect(page.getByText("No invoices yet")).toBeVisible();
  await expectAccessible(page, testInfo, "invoices");
});

test("the owner sees the trial chip with 3 days left and can hide it", async ({ page }) => {
  await setSubscription({ key: "growth", status: "trialing", trialDays: 2 });
  await signIn(page, owner);
  await expect(page.getByText(/Your Growth trial ends in 2 days/)).toBeVisible();
  await page.getByRole("button", { name: "Hide until tomorrow" }).click();
  await expect(page.getByText(/Your Growth trial ends in/)).toHaveCount(0);
});

test("a plan that does not allow another calendar refuses it and the upgrade dialog explains", async ({ page }, testInfo) => {
  // Free allows one calendar, and the sample business already has two, so adding a third is refused by the server.
  await setSubscription({ key: "free", status: "free" });
  await signIn(page, owner, undefined, "/doctors");
  await page.getByRole("button", { name: /^Add practitioner$/ }).click();
  const form = page.getByRole("dialog");
  await form.getByRole("textbox", { name: "Full name" }).fill("Dr Plan Limit");
  await form.getByRole("textbox", { name: /^Title/ }).fill("Dentist");
  await form.getByRole("textbox", { name: /^Specialty|^Speciality/ }).fill("General dentistry");
  await form.getByRole("textbox", { name: "Work email" }).fill(`limit.${Date.now()}@example.com`);
  for (const box of await form.getByRole("checkbox").all()) if (!(await box.isChecked())) await box.check();
  await form.getByRole("button", { name: /^(Add practitioner|Save|Add)/ }).last().click();

  const dialog = page.getByRole("dialog", { name: "This needs a bigger plan" });
  await expect(dialog.getByText(/Your Free plan includes 1 \S+ calendar. Starter includes 3./)).toBeVisible();
  await expectAccessible(page, testInfo, "upgrade dialog");
  await dialog.getByRole("button", { name: "See plans" }).click();
  await expect(page.getByRole("heading", { name: "Plan and billing", level: 2 })).toBeVisible();
  await setSubscription({ key: "growth", status: "trialing", trialDays: 14 });
});
