import { expect, test } from "@playwright/test";

import { chooseBookingSlot, fillCustomerDetails, newCustomer, signIn, withOwnerDatabase } from "./support/journey";

test("staff of one business cannot see or change another business's booking", async ({ page, baseURL }) => {
  const customer = newCustomer("Tanvi");
  await chooseBookingSlot(page, { slug: "lotus-dental", service: "Dental consultation", practitioner: "Dr Kavya Rao" });
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();

  const [booking] = await withOwnerDatabase((sql) => sql<{ id: string }[]>`
    SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE p.email = ${customer.email}
  `);
  expect(booking?.id).toBeTruthy();

  // Signed in as the owner of a different business.
  await signIn(page, "cedar.owner@example.com");

  await page.goto(`/appointments/${booking!.id}`);
  await expect(page.getByText(customer.lastName)).toHaveCount(0);

  const snapshot = await page.request.get("/api/staff/snapshot");
  expect(snapshot.status()).toBe(200);
  expect(await snapshot.text()).not.toContain(customer.lastName);

  const change = await page.request.patch(`/api/appointments/${booking!.id}/status`, {
    data: { status: "cancelled", reason: "isolation check", expectedVersion: 1 },
    headers: { origin: baseURL! },
  });
  expect([403, 404]).toContain(change.status());

  const [after] = await withOwnerDatabase((sql) => sql<{ status: string }[]>`SELECT status FROM appointments WHERE id = ${booking!.id}`);
  expect(after?.status).toBe("booked");
});
