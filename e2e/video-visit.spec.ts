import { expect, test } from "@playwright/test";

import { chooseCard, expectAccessible, fillCustomerDetails, newCustomer, newPage, signIn, withOwnerDatabase } from "./support/journey";

const owner = "kalendr.owner@example.com";

// Fake camera and microphone, allowed without a prompt, so the device check and the test-mode self view have something to show.
test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["camera", "microphone"],
});

/** Offers video next to the visit in person, the way the service editor's "Where" tab saves it. */
async function offerVideo(service: string): Promise<void> {
  await withOwnerDatabase(async (sql) => {
    await sql`
      INSERT INTO service_location_options (tenant_id, service_id, kind, location_id, sort_order)
      SELECT s.tenant_id, s.id, 'in_person', sl.location_id, 0
      FROM services s JOIN service_locations sl ON sl.tenant_id = s.tenant_id AND sl.service_id = s.id
      WHERE s.name = ${service} AND s.tenant_id = (SELECT id FROM tenants WHERE slug = 'lotus-dental')
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO service_location_options (tenant_id, service_id, kind, sort_order)
      SELECT s.tenant_id, s.id, 'video', 1 FROM services s
      WHERE s.name = ${service} AND s.tenant_id = (SELECT id FROM tenants WHERE slug = 'lotus-dental')
      ON CONFLICT DO NOTHING
    `;
  });
}

test.afterAll(async () => {
  // Put the service back to its single way of meeting so the other journeys book as before.
  await withOwnerDatabase((sql) => sql`
    DELETE FROM service_location_options WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'lotus-dental')
      AND service_id IN (SELECT id FROM services WHERE name = 'Dental consultation')
  `);
});

test("a customer and a staff member meet in a video visit (test mode)", async ({ browser }, testInfo) => {
  const customer = newCustomer("Meera");

  // 1. The owner offers video for a service.
  await offerVideo("Dental consultation");

  // 2. The customer books it as a video visit.
  const bookingPage = await newPage(browser, testInfo);
  await bookingPage.goto("/book/lotus-dental");
  await chooseCard(bookingPage, "Dental consultation");
  await chooseCard(bookingPage, "Dr Kavya Rao");
  await expect(bookingPage.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
  await bookingPage.getByRole("radiogroup").last().getByRole("radio").first().click();
  await expect(bookingPage.getByRole("heading", { level: 1, name: "How would you like to meet?" })).toBeVisible();
  await chooseCard(bookingPage, "Video call");
  await expect(bookingPage.getByRole("heading", { level: 1, name: "Last step: your details" })).toBeVisible();
  await fillCustomerDetails(bookingPage, customer);
  await bookingPage.getByRole("button", { name: "Confirm booking" }).click();
  await expect(bookingPage.getByRole("region", { name: "You’re booked" })).toBeVisible();
  await expect(bookingPage.getByRole("link", { name: "Join video visit" })).toBeVisible();
  const manageHref = await bookingPage.getByRole("link", { name: "Manage appointment" }).getAttribute("href");
  const token = manageHref!.replace("/manage/", "");

  // 3. The clock cannot move in the running app, so the visit is moved to start in five minutes.
  const [appointment] = await withOwnerDatabase((sql) => sql<{ id: string }[]>`
    UPDATE appointments a
    SET starts_at = now() + interval '5 minutes', ends_at = now() + interval '35 minutes'
    FROM patients p
    WHERE p.id = a.patient_id AND p.email = ${customer.email}
    RETURNING a.id
  `);
  expect(appointment?.id).toBeTruthy();
  // The worker makes the room 15 minutes before the start. Moving the clock isn't possible here, so make the
  // room the way its handler does (the handler itself is covered by the integration tests).
  await withOwnerDatabase((sql) => sql`
    INSERT INTO video_rooms (tenant_id, appointment_id, provider, provider_room_name, room_url, expires_at)
    SELECT a.tenant_id, a.id, 'fake', ${`e2e-${appointment!.id.slice(0, 8)}`}, ${`kalendr-test-room://e2e-${appointment!.id.slice(0, 8)}`}, now() + interval '65 minutes'
    FROM appointments a WHERE a.id = ${appointment!.id}
    ON CONFLICT (tenant_id, appointment_id) DO NOTHING
  `);

  // 4. The customer opens their visit page, passes the check and waits.
  const customerPage = await newPage(browser, testInfo);
  await customerPage.goto(`/visit/${token}?test=1`);
  await expect(customerPage.getByRole("heading", { level: 1, name: "Test your camera" })).toBeVisible();
  await expect(customerPage.getByRole("button", { name: /I'm ready/ })).toHaveCount(0);

  await customerPage.goto(`/visit/${token}`);
  await customerPage.getByRole("button", { name: "Turn on camera and microphone" }).click();
  await expect(customerPage.getByLabel("Your camera preview")).toBeVisible();
  await expectAccessible(customerPage, testInfo, "video device check");
  await customerPage.getByRole("button", { name: /I'm ready/ }).click();
  await expect(customerPage.getByText(/has not joined yet|will let you in shortly/)).toBeVisible({ timeout: 60_000 });
  await expect(customerPage.getByText("If the call won't work, phone us instead.")).toBeVisible();

  // 5. Staff open the host page, see who is waiting, and let them in.
  const staffPage = await newPage(browser, testInfo);
  await signIn(staffPage, owner, undefined, `/visit/host/${appointment!.id}`);
  await expect(staffPage.getByText(`${customer.firstName} is waiting`)).toBeVisible({ timeout: 30_000 });
  await expectAccessible(staffPage, testInfo, "video host page");
  await staffPage.getByRole("button", { name: "Start the call" }).click();
  await expect(staffPage.getByTestId("video-call")).toBeVisible();
  await staffPage.getByRole("button", { name: "Let them in" }).click();

  // 6. Both pages reach the call. Test mode shows only each person's own camera.
  await expect(customerPage.getByTestId("video-call")).toBeVisible({ timeout: 30_000 });
  await expect(customerPage.getByText(/Test mode: nobody else can join/)).toBeVisible();
  await expect(staffPage.getByText(/Test mode: nobody else can join/)).toBeVisible();
});
