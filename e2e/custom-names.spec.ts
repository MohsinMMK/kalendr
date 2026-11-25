import { expect, test, type Page } from "@playwright/test";

import { expectAccessible, signIn, unique, withOwnerDatabase } from "./support/journey";

/**
 * Lane B of the customization wave: a business gives its own names to its provider word, a role and the sidebar's entries,
 * hides and moves entries, and every screen follows. Runs on the seeded salon (Cedar Hair Studio), never on a clinic.
 */
const slug = "cedar-hair";
const owner = "cedar.owner@example.com";

// The pages a salon's owner can reach from the sidebar (Records is off for a salon). Settings is crawled separately.
const sidebarPages = [
  "/dashboard", "/schedule", "/bookings", "/patients", "/follow-ups", "/classes", "/messages",
  "/billing", "/campaigns", "/routing-forms", "/offers", "/reports", "/doctors", "/profile", "/appointments/new",
];
// Words of a clinic. A salon's screens must say its own words instead.
const clinicWords = /\b(patients?|clinics?|practitioners?|doctors?|dentists?|dental|medical|prescriptions?)\b/i;

let original: { terminology: unknown; layout: unknown } | null = null;

test.beforeAll(async () => {
  await withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ terminology: unknown; layout: unknown }[]>`select terminology, layout from tenants where slug = ${slug}`;
    original = row ?? null;
  });
});

test.afterAll(async () => {
  if (!original) return;
  const saved = original;
  await withOwnerDatabase(async (sql) => {
    await sql`update tenants set terminology = ${sql.json(saved.terminology as never)}, layout = ${sql.json(saved.layout as never)} where slug = ${slug}`;
    await sql`update memberships set job_title = null where tenant_id = (select id from tenants where slug = ${slug})`;
  });
});

/** Visible text, plus the words screen readers get, of the page as it stands. */
async function wordsOnPage(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [document.title];
    found.push(...(document.body.innerText.split("\n")));
    for (const element of document.querySelectorAll("[aria-label], [placeholder], [title], img[alt]")) {
      for (const attribute of ["aria-label", "placeholder", "title", "alt"]) {
        const value = element.getAttribute(attribute);
        if (value) found.push(value);
      }
    }
    return found;
  });
}

async function clinicWordHits(page: Page, label: string): Promise<string[]> {
  const words = await wordsOnPage(page);
  if (process.env.KALENDR_E2E_VERBOSE) console.log(`crawl ${label}: ${words.length} lines, title "${words[0]}"`);
  return words.filter((line) => clinicWords.test(line)).map((line) => `${label}: ${line.trim().slice(0, 160)}`);
}

async function crawlSidebarPages(page: Page): Promise<string[]> {
  const hits: string[] = [];
  for (const path of sidebarPages) {
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(page.locator("#clinic-main")).toBeVisible();
    hits.push(...await clinicWordHits(page, path));
  }
  // The Help panel and the business's own page are entries in the sidebar too.
  await page.goto("/dashboard");
  await page.locator("[data-nav-id='help']").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  hits.push(...await clinicWordHits(page, "help"));
  await page.keyboard.press("Escape");
  await page.goto(`/b/${slug}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  hits.push(...await clinicWordHits(page, `/b/${slug}`));
  // Settings: every section this owner can open.
  await page.goto("/settings");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav).toBeVisible();
  const sections = await nav.getByRole("button").allInnerTexts();
  for (const section of sections) {
    await nav.getByRole("button", { name: section.split("\n")[0]!, exact: false }).first().click();
    await page.waitForLoadState("networkidle").catch(() => {});
    hits.push(...await clinicWordHits(page, `settings / ${section.split("\n")[0]}`));
  }
  return [...new Set(hits)];
}

test("no page reachable from a salon's sidebar uses a clinic's words", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "One run is enough: both projects see the same words.");
  test.setTimeout(240_000);
  await signIn(page, owner);
  expect(await crawlSidebarPages(page)).toEqual([]);
});

test("a salon's owner names the provider word, a role and the sidebar, and every screen follows", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The sidebar is arranged on desktop; the phone bar is covered by the component tests.");
  test.setTimeout(240_000);
  const mark = unique();
  await signIn(page, owner);

  // 1. Words and a role name, beside each other in Settings → Business profile.
  await page.goto("/settings");
  const settingsNav = page.getByRole("navigation", { name: "Settings sections" });
  await settingsNav.getByRole("button", { name: "Business profile" }).click();
  await page.locator("#term-provider-one").fill("team member");
  await page.locator("#term-provider-many").fill("Team");
  await page.getByLabel("Receptionist", { exact: true }).fill("Front desk");
  // A name found nowhere else, so its absence from the customers' pages means something.
  await page.getByLabel("Billing", { exact: true }).fill("Tillkeeper Qz");
  await page.getByRole("button", { name: "Save business profile" }).click();
  await expect(page.getByText("Every screen now uses these words.")).toBeVisible();
  await page.getByRole("link", { name: /Back to / }).click();

  // Customers' pages carry the business's words but never the staff role names, not even in the page data.
  for (const path of [`/b/${slug}`, `/book/${slug}`]) {
    const response = await page.request.get(path);
    expect(response.ok(), path).toBe(true);
    const body = await response.text();
    expect(body, path).not.toContain("Tillkeeper Qz");
    expect(body, path).not.toContain("Front desk");
  }

  // 2. The sidebar: rename two entries, hide one and move one, from a section heading's ⋯.
  const sidebar = page.locator("[data-slot='sidebar-inner']").first();
  await page.getByRole("button", { name: "Front desk options" }).click();
  await page.getByRole("menuitem", { name: "Customize sidebar" }).click();
  const drawer = page.getByRole("dialog", { name: "Customize sidebar" });
  await expect(drawer).toBeVisible();
  await expectAccessible(page, testInfo, "customize sidebar panel", "[role='dialog']");
  if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/customize-sidebar-drawer.png` });

  // Drag Classes above Follow-ups by its handle, then move Today below Schedule with Alt and an arrow key in its name.
  const order = drawer.getByRole("textbox", { name: /^Name for / });
  const standardNames = async () => order.evaluateAll((nodes) => nodes.slice(0, 7).map((node) => node.getAttribute("aria-label")?.replace("Name for ", "")));
  const from = (await drawer.getByRole("button", { name: /^Move Classes\./ }).boundingBox())!;
  const to = (await drawer.getByRole("button", { name: /^Move Follow-ups\./ }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 15, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - 10, { steps: 12 });
  await page.mouse.up();
  await expect.poll(standardNames).toEqual(["Today", "Schedule", "Bookings", "Clients", "Classes", "Follow-ups", "Messages"]);
  await drawer.getByLabel("Name for Today", { exact: true }).press("Alt+ArrowDown");
  await expect.poll(standardNames).toEqual(["Schedule", "Today", "Bookings", "Clients", "Classes", "Follow-ups", "Messages"]);

  const rename = async (standard: string, name: string) => {
    const field = drawer.getByLabel(`Name for ${standard}`, { exact: true });
    await field.fill(name);
    await field.press("Enter");
  };
  await rename("Schedule", "Diary");
  await rename("Messages", "Inbox");
  await drawer.getByRole("switch", { name: "Show Offers in the sidebar" }).click();
  // The panel stays open through a drag and the clicks after it.
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Done" }).click();
  await expect(drawer).toBeHidden();
  // Behind the open panel the sidebar is inert; once it closes, the new names are there at once.
  await expect(sidebar.getByRole("link", { name: "Diary" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Offers" })).toHaveCount(0);
  // The layout saves a moment after the last change.
  await expect.poll(async () => withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ layout: { pages?: { sidebar?: { options?: Record<string, string> } } } }[]>`select layout from tenants where slug = ${slug}`;
    return row?.layout?.pages?.sidebar?.options?.["name-messages"] ?? "";
  }), { timeout: 15_000 }).toBe("Inbox");

  // 3. After a reload everything still reads the business's own names.
  await page.reload();
  const entries = sidebar.getByRole("link");
  await expect(sidebar.getByRole("link", { name: "Diary" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Inbox" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Offers" })).toHaveCount(0);
  const frontDesk = await sidebar.locator("[data-nav-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-nav-id")));
  expect(frontDesk.indexOf("classes")).toBeLessThan(frontDesk.indexOf("follow-ups"));
  expect(frontDesk.indexOf("schedule")).toBeLessThan(frontDesk.indexOf("dashboard"));
  expect(await entries.count()).toBeGreaterThan(5);

  if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/customized-sidebar.png` });

  // The page's own title and the browser tab's both follow.
  await sidebar.getByRole("link", { name: "Diary" }).click();
  await expect(page).toHaveURL(/\/schedule/);
  await expect(page.getByRole("heading", { level: 1, name: "Diary" })).toBeVisible();
  await expect(page).toHaveTitle(/Diary/);
  await sidebar.getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(page).toHaveTitle(/Inbox/);

  // The command palette uses the same names, in the same order, and leaves out what is hidden.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog");
  await expect(palette.getByRole("option", { name: "Diary" })).toBeVisible();
  await expect(palette.getByRole("option", { name: "Inbox" })).toBeVisible();
  await expect(palette.getByRole("option", { name: "Offers" })).toHaveCount(0);
  await expect(palette.getByRole("option", { name: "Team", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // 4. The role has its new name where roles are chosen, and a job title leads the account section.
  // Who can sign in is a tab on the Team page, beside the people who take bookings.
  await page.goto("/doctors?tab=access");
  await page.getByRole("button", { name: "Invite staff" }).click();
  await page.getByRole("combobox", { name: "Role" }).click();
  await expect(page.getByRole("option", { name: /^Front desk/ })).toBeVisible();
  // The renamed billing role is there for staff, so its absence from customers' pages (checked above) means something.
  await expect(page.getByRole("option", { name: /^Tillkeeper Qz/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /^Receptionist/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.goto("/profile");
  await page.getByLabel("Job title").fill(`Owner and colourist ${mark}`);
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Job title saved")).toBeVisible();
  await expect(sidebar.getByText(`Owner and colourist ${mark}`)).toBeVisible();

  // 5. The Settings → Customize sidebar panel is the same editor, and it is accessible.
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Customize sidebar" }).click();
  await expect(page.getByLabel("Name for Schedule", { exact: true })).toHaveValue("Diary");
  await expectAccessible(page, testInfo, "settings customize sidebar", "#clinic-main");
  await page.getByRole("button", { name: "Reset sidebar" }).click();
  await expect(page.getByLabel("Name for Schedule", { exact: true })).toHaveValue("Schedule");
  await page.getByRole("link", { name: /Back to / }).click();

  // 6. Under the new names, none of the pages reachable from the sidebar uses a clinic's words.
  expect(await crawlSidebarPages(page)).toEqual([]);
});

test("on a phone the sidebar is customized from a heading's menu and from Settings", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "The desktop journey covers the arranging; this is the phone's layout.");
  test.setTimeout(180_000);
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": "192.0.2.181" });
  await signIn(page, owner);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Front desk options" }).click();
  await page.getByRole("menuitem", { name: "Customize sidebar" }).click();
  const drawer = page.getByRole("dialog", { name: "Customize sidebar" });
  await expect(drawer).toBeVisible();
  await expectAccessible(page, testInfo, "customize sidebar panel on a phone", "[role='dialog']");
  if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/customize-sidebar-phone.png` });
  const field = drawer.getByLabel("Name for Messages", { exact: true });
  await field.fill("Inbox");
  await field.press("Enter");
  await drawer.getByRole("button", { name: "Done" }).click();
  await expect(drawer).toBeHidden();
  // The phone menu closed when the panel opened, so the bar is what is left, with the new name.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Inbox" })).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Customize sidebar" }).click();
  await expect(page.getByLabel("Name for Messages", { exact: true })).toHaveValue("Inbox");
  if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/settings-customize-sidebar-phone.png` });
  await page.getByRole("button", { name: "Reset sidebar" }).click();
  await expect(page.getByLabel("Name for Messages", { exact: true })).toHaveValue("Messages");
});
