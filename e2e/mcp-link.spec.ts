import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "@playwright/test";

import { fillCustomerDetails, newCustomer, withOwnerDatabase } from "./support/journey";

/**
 * Feature 54: an assistant connected to Kalendr finds open times and starts a booking; the link it returns books that very time
 * after the customer confirms, even though the assistant's hold is still on it.
 */
async function ask<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const reply = await client.callTool({ name, arguments: args });
  const text = (reply.content as Array<{ type: string; text?: string }>).find((part) => part.type === "text")?.text ?? "{}";
  if (reply.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as T;
}

test("a link from an assistant books the held time after the customer confirms", async ({ page }, testInfo) => {
  const address = `192.0.2.${testInfo.project.name === "phone" ? 191 : 91}`;
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": address });
  const transport = new StreamableHTTPClientTransport(new URL("/api/mcp", process.env.KALENDR_APP_URL), { requestInit: { headers: { "x-forwarded-for": address } } });
  const client = new Client({ name: "e2e-assistant", version: "1" });
  await client.connect(transport);
  try {
    const { services } = await ask<{ services: Array<{ id: string; name: string }> }>(client, "list_services", { business: "lotus-dental" });
    const service = services.find((entry) => entry.name === "Dental consultation")!;
    const { people } = await ask<{ people: Array<{ id: string; name: string }> }>(client, "list_people", { business: "lotus-dental", serviceId: service.id });
    const doctor = people.find((entry) => entry.name === "Dr Kavya Rao")!;
    const from = new Date(Date.now() + 2 * 86_400_000);
    const found = await ask<{ times: Array<{ startsAt: string; personId: string }> }>(client, "find_open_times", {
      business: "lotus-dental", serviceId: service.id, personId: doctor.id, from: from.toISOString(), to: new Date(from.getTime() + 3 * 86_400_000).toISOString(),
    });
    expect(found.times.length).toBeGreaterThan(0);
    const time = found.times[0]!;
    const started = await ask<{ status: string; bookingLink: string }>(client, "start_booking", { business: "lotus-dental", serviceId: service.id, personId: doctor.id, startsAt: time.startsAt });
    expect(started.status).toBe("awaiting_customer_confirmation");

    // The customer opens the link while the assistant's hold is still on that time.
    const customer = newCustomer("Assistant");
    const link = new URL(started.bookingLink);
    await page.goto(`${link.pathname}${link.search}`);
    // The service, person and time from the link stay chosen.
    const heading = page.getByRole("heading", { level: 1 });
    // Whatever comes first, the flow gets to the details with the linked time chosen. The time screen moves on by
    // itself for a linked time; any other screen moves on when its chosen card is tapped again.
    for (let step = 0; step < 6; step += 1) {
      await expect(heading).toBeVisible();
      const current = await heading.innerText();
      // The flow can reach the details on its own while the page loads.
      if (current === "Last step: your details") break;
      if (current !== "When works for you?") await page.locator("label").filter({ has: page.locator("[data-checked]") }).first().click();
      await expect(heading).not.toHaveText(current, { timeout: 10_000 });
    }
    await expect(page.getByRole("heading", { level: 1, name: "Last step: your details" })).toBeVisible();
    await fillCustomerDetails(page, customer);
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible({ timeout: 20_000 });

    const rows = await withOwnerDatabase((sql) => sql<{ starts_at: Date }[]>`
      select a.starts_at from appointments a join patients p on p.id = a.patient_id and p.tenant_id = a.tenant_id where p.email = ${customer.email}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.starts_at.toISOString()).toBe(new Date(time.startsAt).toISOString());
    // The assistant's hold is gone, replaced by the booking.
    const holds = await withOwnerDatabase((sql) => sql`select 1 from slot_holds where starts_at = ${time.startsAt}::timestamptz and practitioner_id = ${doctor.id}`);
    expect(holds).toHaveLength(0);
  } finally {
    await client.close();
  }
});
