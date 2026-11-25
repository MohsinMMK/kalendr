import { expect, test } from "@playwright/test";

import { expectAccessible, newPage, signIn, withOwnerDatabase } from "./support/journey";

const owner = "kalendr.owner@example.com";

const slug = "lotus-dental";

// Later journeys must not find the chat button on the booking page, so what this file turns on is removed again.
test.afterAll(async () => {
  await withOwnerDatabase(async (sql) => {
    await sql`delete from assistant_conversations where tenant_id = (select id from tenants where slug = ${slug})`;
    await sql`delete from assistant_settings where tenant_id = (select id from tenants where slug = ${slug})`;
  });
});

test.beforeAll(async () => {
  await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    await sql`
      insert into assistant_settings (tenant_id, enabled_web, enabled_whatsapp, tone) values (${tenant!.id}, true, false, 'friendly')
      on conflict (tenant_id) do update set enabled_web = true`;
  });
});

const phoneNumber = () => `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

test("a visitor books by chat: real times, an explicit Confirm, and the booking shows up with source assistant", async ({ page, browser }, testInfo) => {
  const number = phoneNumber();
  await page.goto(`/book/${slug}`);
  await page.getByRole("button", { name: "Ask us" }).click();
  const chat = page.getByRole("dialog");
  await expect(chat.getByText("Automated assistant", { exact: true })).toBeVisible();
  await expectAccessible(page, testInfo, "assistant chat, empty");

  await chat.getByLabel("Your message").fill("I'd like a dental consultation in the next few days");
  await chat.getByRole("button", { name: "Send" }).click();
  const log = chat.getByRole("log", { name: "Conversation" });
  await expect(log.getByText(/automated booking assistant, not a person/)).toBeVisible();
  await expect(log.getByText(/Here are some times/)).toBeVisible();

  await chat.getByLabel("Your message").fill(`the first one please. My name is Asha Rao, ${number}`);
  await chat.getByRole("button", { name: "Send" }).click();
  const confirmGroup = chat.getByRole("group", { name: "Confirm this change" });
  await expect(confirmGroup).toBeVisible();
  await expect(confirmGroup.getByText(/Dental .+ with Dr .+ at .+, for Asha Rao/)).toBeVisible();
  await expectAccessible(page, testInfo, "assistant chat, waiting for a confirm");

  // Nothing is booked until the Confirm button is pressed.
  const before = await withOwnerDatabase((sql) => sql`select a.id from appointments a join patients p on p.id = a.patient_id where p.phone like ${`%${number.slice(-8)}`}`);
  expect(before).toHaveLength(0);
  await confirmGroup.getByRole("button", { name: "Confirm" }).click();
  await expect(log.getByText(/All set/)).toBeVisible();
  await expect(confirmGroup).toBeHidden();

  const booked = await withOwnerDatabase((sql) => sql<{ booking_source: string }[]>`select a.booking_source from appointments a join patients p on p.id = a.patient_id where p.phone like ${`%${number.slice(-8)}`}`);
  expect(booked).toHaveLength(1);
  expect(booked[0]!.booking_source).toBe("assistant");

  // The booking is on the front desk's list, labelled with how it came in.
  const staff = await newPage(browser, testInfo);
  await staff.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 163 : 63}` });
  await signIn(staff, owner);
  await staff.goto("/bookings");
  await staff.getByRole("button", { name: /^Filter/ }).click();
  await staff.getByPlaceholder("Name or phone").fill(number);
  await staff.keyboard.press("Escape");
  // The number is this run's own, so the list holds this booking only; the Source column says how it came in.
  await expect(staff.getByText("Asha Rao").first()).toBeVisible();
  // The Source column is a table column; the phone's list is cards that leave it out, so the label is checked at desktop width.
  if (testInfo.project.name === "desktop") await expect(staff.getByText("Booking assistant").first()).toBeVisible();
  await staff.close();

  // The chat survives a reload in the same tab.
  await page.reload();
  await page.getByRole("button", { name: "Ask us" }).click();
  await expect(page.getByRole("dialog").getByRole("log", { name: "Conversation" }).getByText(/All set/)).toBeVisible();
});

test("a question about medicine gets the safe reply, a handoff, and no model", async ({ page }) => {
  await page.goto(`/book/${slug}`);
  await page.getByRole("button", { name: "Ask us" }).click();
  const chat = page.getByRole("dialog");
  await chat.getByLabel("Your message").fill("What should I take for a toothache?");
  await chat.getByRole("button", { name: "Send" }).click();
  const log = chat.getByRole("log", { name: "Conversation" });
  await expect(log.getByText(/can't give medical, legal or financial advice/)).toBeVisible();
  await expect(chat.getByPlaceholder("The team will read this")).toBeVisible();
});

test("the chat is not offered when the business has it switched off", async ({ page }) => {
  await withOwnerDatabase((sql) => sql`update assistant_settings set enabled_web = false where tenant_id = (select id from tenants where slug = ${slug})`);
  try {
    await page.goto(`/book/${slug}`);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask us" })).toHaveCount(0);
  } finally {
    await withOwnerDatabase((sql) => sql`update assistant_settings set enabled_web = true where tenant_id = (select id from tenants where slug = ${slug})`);
  }
});
