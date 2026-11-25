import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { chooseBookingSlot, fillCustomerDetails, newCustomer, newPage, signIn, withOwnerDatabase } from "./support/journey";

/**
 * Feature 56: staff notifications. The Notifications page (from the profile menu) is a grid of events by channels with quiet
 * hours and a morning summary, and the choices stay. The bell shows what is unread after a customer books and marks it read.
 */
const owner = "kalendr.owner@example.com";

test.beforeEach(async ({ context }, testInfo) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 171 : 71}` });
});

async function resetOwnerChoices(): Promise<void> {
  await withOwnerDatabase((sql) => sql`
    update memberships set quiet_start_minute = null, quiet_end_minute = null, digest_enabled = null, digest_minute = null
    where role = 'owner' and tenant_id = (select id from tenants where slug = 'lotus-dental')`);
  await withOwnerDatabase((sql) => sql`
    delete from notification_preferences where membership_id in (select id from memberships where role = 'owner' and tenant_id = (select id from tenants where slug = 'lotus-dental'))`);
}

test("an owner opens Notifications, chooses channels, quiet hours and a morning summary, and the choices stay", async ({ page }) => {
  await resetOwnerChoices();
  try {
    await signIn(page, owner, undefined, "/profile");
    // The profile menu leads here too; the profile page has a link to it.
    await page.getByRole("link", { name: "Open notifications" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
    const grid = page.getByRole("table", { name: "Which alerts reach you, and how" });
    await expect(grid).toBeVisible();
    // The page itself; the bell is scanned in the next test.
    const scan = await new AxeBuilder({ page }).include("main").exclude('button[aria-label^="Notifications"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(scan.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);

    // An owner starts with the bell on and email off for each alert; turn one email on.
    const emailSwitch = grid.getByRole("switch", { name: /New online .*: Email/ });
    await expect(emailSwitch).not.toBeChecked();
    await emailSwitch.click();
    await expect(emailSwitch).toBeChecked();

    // Quiet hours and the summary: owners have the summary on unless they turn it off.
    const digest = page.getByRole("switch", { name: "Morning summary by email" });
    await expect(digest).toBeChecked();
    await page.getByRole("switch", { name: "Quiet hours" }).click();
    await page.getByLabel("From").fill("22:00");
    await page.getByLabel("Until").fill("07:00");
    await digest.click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();

    await page.reload();
    await expect(grid.getByRole("switch", { name: /New online .*: Email/ })).toBeChecked();
    await expect(page.getByRole("switch", { name: "Quiet hours" })).toBeChecked();
    await expect(page.getByLabel("From")).toHaveValue("22:00");
    await expect(page.getByLabel("Until")).toHaveValue("07:00");
    await expect(page.getByRole("switch", { name: "Morning summary by email" })).not.toBeChecked();
  } finally {
    await resetOwnerChoices();
  }
});

test("a booking shows as an unread alert in the bell, and opening it marks it read", async ({ page, browser }, testInfo) => {
  await withOwnerDatabase((sql) => sql`delete from staff_notifications where tenant_id = (select id from tenants where slug = 'lotus-dental')`);
  await signIn(page, owner, undefined, "/dashboard");
  const customer = newCustomer("Bell");
  const visitor = await newPage(browser, testInfo);
  await visitor.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 172 : 72}` });
  await chooseBookingSlot(visitor, { slug: "lotus-dental", service: "Dental consultation", practitioner: "Dr Kavya Rao" });
  await fillCustomerDetails(visitor, customer);
  await visitor.getByRole("button", { name: "Confirm booking" }).click();
  await expect(visitor.getByRole("region", { name: "You’re booked" })).toBeVisible();
  await visitor.context().close();

  await page.reload();
  const bell = page.getByRole("button", { name: /^Notifications: \d+ unread/ });
  await expect(bell).toBeVisible();
  // The count badge is readable: white on a dark red, so the scan of the bell finds nothing.
  const scan = await new AxeBuilder({ page }).include('button[aria-label^="Notifications"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(scan.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  // The count is drawn by CSS, which the scan cannot read, so check its colours directly: white on the badge clears 4.5:1.
  const colours = await bell.locator("span[data-count]").evaluate((badge) => {
    const style = getComputedStyle(badge);
    return { background: style.backgroundColor, text: style.color };
  });
  const channels = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const luminance = ([r, g, b]: number[]) => {
    const part = (channel: number) => { const value = (channel ?? 0) / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * part(r!) + 0.7152 * part(g!) + 0.0722 * part(b!);
  };
  const lighter = Math.max(luminance(channels(colours.background)), luminance(channels(colours.text)));
  const darker = Math.min(luminance(channels(colours.background)), luminance(channels(colours.text)));
  expect((lighter + 0.05) / (darker + 0.05)).toBeGreaterThanOrEqual(4.5);
  await bell.click();
  const drawer = page.getByRole("dialog", { name: "Notifications" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Notification settings" })).toHaveAttribute("href", "/profile/notifications");
  await expect(drawer.getByRole("tab", { name: /^Alerts/ })).toHaveAttribute("aria-selected", "true");
  const item = drawer.getByRole("button", { name: /Unread\. New booking at/ }).first();
  await expect(item).toBeVisible();
  // The notification names no customer (the queue behind the drawer may show the booking itself).
  await expect(drawer.getByText(customer.lastName)).toHaveCount(0);
  const shots = process.env.KALENDR_E2E_SHOTS;
  if (shots) {
    if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${shots}/bell-drawer-${page.viewportSize()?.width}.png` });
  }
  // The other tab holds what needs a decision; switching to it and back keeps the alerts.
  await drawer.getByRole("tab", { name: /^Needs attention/ }).click();
  await expect(drawer.getByRole("tab", { name: /^Needs attention/ })).toHaveAttribute("aria-selected", "true");
  await expect(drawer.getByRole("region", { name: "Needs attention" }).or(drawer.getByText("All clear. Nothing needs a decision right now."))).toBeVisible();
  await drawer.getByRole("tab", { name: /^Alerts/ }).click();
  await item.click();
  await page.waitForURL(/\/schedule\?open=/);
  // Opening it marked it read: the bell has no unread count, and the list shows the alert without the unread mark.
  const readBell = page.getByRole("button", { name: /^Notifications(?!: \d+ unread)/ });
  await expect(readBell).toBeVisible();
  // On a phone the booking opens over the page; close it to reach the bell again.
  await page.keyboard.press("Escape");
  await readBell.click();
  const reopened = page.getByRole("dialog", { name: "Notifications" });
  await expect(reopened.getByRole("button", { name: /^New booking at/ }).first()).toBeVisible();
  await expect(reopened.getByRole("button", { name: /^Unread\./ })).toHaveCount(0);
  await expect(reopened.getByRole("button", { name: "Mark all read" })).toBeDisabled();
  // One bell fits a 360px header without it overflowing sideways.
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(reopened).toBeVisible();
  if (shots) {
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${shots}/bell-drawer-360.png` });
  }
  await page.keyboard.press("Escape");
  await expect(reopened).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a booking request for today is approved from the bell's Needs attention tab", async ({ page, browser }, testInfo) => {
  const service = "Dental cleaning";
  await withOwnerDatabase((sql) => sql`update services set approval_rule = 'always', booking_mode = 'request' where name = ${service}`);
  const customer = newCustomer("Request");
  try {
    const visitor = await newPage(browser, testInfo);
    await visitor.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 173 : 73}` });
    await chooseBookingSlot(visitor, { slug: "lotus-dental", service, practitioner: "Dr Arjun Shah" });
    await fillCustomerDetails(visitor, customer);
    await visitor.getByRole("button", { name: /Send request|Confirm booking/ }).click();
    await expect(visitor.getByText(/waiting for approval/i).first()).toBeVisible();
    await visitor.context().close();
    // Needs attention lists today's requests: move this one to now so it is today's, whatever day the slot fell on.
    await withOwnerDatabase((sql) => sql`
      update appointments set starts_at = now() + interval '1 minute', ends_at = now() + interval '31 minutes'
      where patient_id = (select id from patients where email = ${customer.email}) and status = 'requested'`);

    await signIn(page, owner, undefined, "/dashboard");
    const bell = page.getByRole("button", { name: /need attention/ });
    await bell.click();
    const drawer = page.getByRole("dialog", { name: "Notifications" });
    await drawer.getByRole("tab", { name: /^Needs attention/ }).click();
    const region = drawer.getByRole("region", { name: "Needs attention" });
    const approve = region.getByRole("button", { name: new RegExp(`^Approve request: .*${customer.lastName}`) });
    await expect(approve).toBeVisible();
    await expect(region.getByRole("button", { name: new RegExp(`^Decline request: .*${customer.lastName}`) })).toBeVisible();
    if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/bell-needs-attention-${page.viewportSize()?.width}.png` });
    await approve.click();
    await expect(page.getByText("Request approved")).toBeVisible();
    // The request leaves the list (a missing-form item for the same visit may stay).
    await expect(approve).toHaveCount(0);
    await expect(region.getByText("Booking request")).toHaveCount(0);
    const [row] = await withOwnerDatabase((sql) => sql<{ status: string }[]>`
      select status from appointments where patient_id = (select id from patients where email = ${customer.email}) order by created_at desc limit 1`);
    expect(row!.status).toBe("booked");
  } finally {
    await withOwnerDatabase(async (sql) => {
      await sql`update services set approval_rule = 'never', booking_mode = 'instant' where name = ${service}`;
      // Leave today's queue as it was for the specs that count it.
      await sql`update appointments set status = 'cancelled' where patient_id = (select id from patients where email = ${customer.email})`;
    });
  }
});
