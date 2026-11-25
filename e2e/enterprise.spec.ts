import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { expectAccessible, signIn, unique, withOwnerDatabase } from "./support/journey";
import { freshCode, recallSecret } from "./support/second-factor";

/**
 * Feature 53: an owner on the Scale plan makes a "Dermatology" team with a page, makes a "Front desk" role that can book but can't
 * take payments, and reads the activity log filtered to failed sign-ins. The company sign-in screens are checked for their states;
 * the signed SAML round trip and the directory are proved in the integration tests.
 */

const owner = "kalendr.owner@example.com";
const business = "lotus-dental";

/** Eleven minutes since the last second-factor check would ask for a code first. */
async function answerStepUp(page: Page): Promise<void> {
  const stepUp = page.getByRole("dialog", { name: "Confirm it's you" });
  if (await stepUp.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await stepUp.getByLabel("Authenticator code").fill(await freshCode(recallSecret(owner)!));
    await stepUp.getByRole("button", { name: "Confirm" }).click();
  }
}

test("an owner makes a team with a page, a role without payments, and filters the activity log", async ({ page }, testInfo) => {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 153 : 53}` });
  const mark = unique();
  const before = await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${business}`;
    const [previous] = await sql<{ plan_key: string; status: string; trial_ends_at: Date | null }[]>`select plan_key, status, trial_ends_at from tenant_subscriptions where tenant_id = ${tenant!.id}`;
    await sql`
      insert into tenant_subscriptions (tenant_id, plan_key, status) values (${tenant!.id}, 'scale', 'active')
      on conflict (tenant_id) do update set plan_key = 'scale', status = 'active', trial_ends_at = null`;
    // Failed sign-ins last week, and one just outside it, for the activity filter.
    const [person] = await sql<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenant!.id} and role <> 'owner' limit 1`;
    for (let day = 1; day <= 3; day += 1) {
      await sql`insert into audit_events (tenant_id, actor_user_id, actor_type, action, outcome, metadata, occurred_at)
        values (${tenant!.id}, ${person!.user_id}, 'staff', 'staff.sign_in.failed', 'failed', ${sql.json({ method: "password", mark })}, now() - ${day} * interval '1 day')`;
    }
    await sql`insert into audit_events (tenant_id, actor_user_id, actor_type, action, outcome, metadata, occurred_at)
      values (${tenant!.id}, ${person!.user_id}, 'staff', 'staff.sign_in.failed', 'failed', ${sql.json({ method: "password", mark: "old" })}, now() - interval '12 days')`;
    return { tenantId: tenant!.id, previous };
  });
  // The phone and desktop runs share one database, and later journeys expect the plan they started with.
  try {
    await journey(page, testInfo, mark);
  } finally {
    await withOwnerDatabase(async (sql) => {
      if (before.previous) {
        await sql`update tenant_subscriptions set plan_key = ${before.previous.plan_key}, status = ${before.previous.status}, trial_ends_at = ${before.previous.trial_ends_at} where tenant_id = ${before.tenantId}`;
      } else {
        await sql`delete from tenant_subscriptions where tenant_id = ${before.tenantId}`;
      }
    });
  }
});

async function journey(page: Page, testInfo: TestInfo, mark: string): Promise<void> {
  await signIn(page, owner, undefined, "/settings");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("button", { name: "Organisation" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Organisation" })).toBeVisible();

  // A team, with a page of its own.
  const teamName = `Dermatology ${mark}`;
  await page.getByRole("button", { name: "New team" }).first().click();
  const teamDialog = page.getByRole("dialog", { name: "New team" });
  await teamDialog.getByLabel("Name", { exact: true }).fill(teamName);
  await teamDialog.getByLabel("About the team").fill("Skin, hair and nails.");
  await teamDialog.getByRole("button", { name: "Make team" }).click();
  await expect(teamDialog).toBeHidden();
  await expect(page.getByRole("list", { name: "Teams" }).getByText(teamName)).toBeVisible();
  const slug = `dermatology-${mark}`;
  const publicPage = await page.context().newPage();
  await publicPage.goto(`/b/${business}/t/${slug}`);
  await expect(publicPage.getByRole("heading", { level: 1, name: teamName })).toBeVisible();
  await expect(publicPage.getByText("Skin, hair and nails.")).toBeVisible();
  await publicPage.close();

  // A role that can book but can't take payments.
  await page.getByRole("tab", { name: "Roles" }).click();
  await page.getByRole("button", { name: "New role" }).first().click();
  const roleDialog = page.getByRole("dialog", { name: "New role" });
  await roleDialog.getByLabel("Name", { exact: true }).fill(`Front desk ${mark}`);
  await expect(roleDialog.getByRole("checkbox", { name: /^Book and change (?!repeating)/ })).toBeChecked();
  const payments = roleDialog.getByRole("checkbox", { name: /Take payments/ });
  if (await payments.isChecked()) await payments.click();
  await expect(payments).not.toBeChecked();
  await roleDialog.getByRole("button", { name: "Make role" }).click();
  await answerStepUp(page);
  await expect(roleDialog).toBeHidden({ timeout: 15_000 });
  const list = page.getByRole("list", { name: "Custom roles" });
  await expect(list.getByText(`Front desk ${mark}`)).toBeVisible();
  await withOwnerDatabase(async (sql) => {
    const rows = await sql<{ permissions: string[]; base_role: string }[]>`select permissions, base_role from custom_roles where name = ${`Front desk ${mark}`}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.permissions).toContain("appointments.book");
    expect(rows[0]!.permissions).not.toContain("payments.collect");
  });

  // Sign-in screen states: no domain yet, then the form to add one.
  await page.getByRole("tab", { name: "Sign-in" }).click();
  await expect(page.getByText("No company domain yet")).toBeVisible();
  await page.getByRole("button", { name: "Add a domain" }).first().click();
  const domainDialog = page.getByRole("dialog", { name: "Add a company domain" });
  await domainDialog.getByLabel("Domain").fill("gmail.com");
  await domainDialog.getByRole("button", { name: "Add domain" }).click();
  await answerStepUp(page);
  await expect(domainDialog.getByText(/Use your company's own domain/)).toBeVisible();
  await domainDialog.getByRole("button", { name: "Cancel" }).click();
  await expectAccessible(page, testInfo, "organisation-sign-in");

  // The activity log, filtered to every failed sign-in in the last 7 days.
  // The activity log is its own page in the sidebar now, under the business section.
  await page.goto("/activity");
  await page.getByRole("combobox", { name: "What happened" }).click();
  await page.getByRole("option", { name: "Failed sign-ins" }).click();
  await page.getByRole("combobox", { name: "When" }).click();
  await page.getByRole("option", { name: "Last 7 days" }).click();
  await expect(page.getByText("A sign-in failed").first()).toBeVisible();
  // Every failed sign-in in the last seven days, and none from before it: the page agrees with the database.
  const expected = await withOwnerDatabase(async (sql) => {
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from audit_events where tenant_id = (select id from tenants where slug = ${business}) and action = 'staff.sign_in.failed' and occurred_at >= now() - interval '7 days'`;
    return rows[0]!.n;
  });
  expect(expected).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("listitem").filter({ hasText: "A sign-in failed" })).toHaveCount(expected);
  await expectAccessible(page, testInfo, "activity-filters");
}
