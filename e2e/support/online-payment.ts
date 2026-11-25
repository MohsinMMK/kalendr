import type { Page } from "@playwright/test";

import { withOwnerDatabase } from "./journey";

/**
 * Arranges the seeded sample business for the online payment journey (feature 23): one service that asks for a
 * deposit, and a business payment account of the built-in `fake` provider (test money, no outside call).
 * Both are put back afterwards, so other journeys keep booking without paying.
 *
 * The seed this relies on: tenant `lotus-dental` with the service `Dental cleaning` (45 minutes, Dr Kavya Rao and
 * Dr Arjun Shah, open times in the next days). Nothing else is created.
 */
export const paidBusiness = {
  slug: "lotus-dental",
  name: "Lotus Dental Studio",
  service: "Dental cleaning",
  practitioner: "Dr Kavya Rao",
  priceMinor: 80_000,
  depositMinor: 20_000,
  payNow: "₹200",
  payLater: "₹600",
} as const;

interface Arranged {
  serviceId: string;
  previous: { paymentMode: string; depositMinor: number | null; priceMinor: number | null };
  createdAccountId: string | null;
}

export async function arrangeDepositService(): Promise<Arranged> {
  return withOwnerDatabase(async (sql) => {
    const [service] = await sql<{ id: string; tenant_id: string; payment_mode: string; deposit_minor: number | null; price_minor: number | null }[]>`
      select s.id, s.tenant_id, s.payment_mode, s.deposit_minor, s.price_minor from services s, tenants t
      where t.slug = ${paidBusiness.slug} and s.tenant_id = t.id and s.name = ${paidBusiness.service} limit 1`;
    if (!service) throw new Error("Seed the e2e database first (lotus-dental, Dental cleaning).");
    await sql`update services set price_minor = ${paidBusiness.priceMinor}, payment_mode = 'deposit', deposit_minor = ${paidBusiness.depositMinor} where id = ${service.id}`;
    return { serviceId: service.id, previous: { paymentMode: service.payment_mode, depositMinor: service.deposit_minor, priceMinor: service.price_minor }, createdAccountId: null };
  });
}

/**
 * Connects the built-in test account the way the owner does, through the app (so its webhook secret is sealed
 * with the business's key like a real one). Needs a signed-in owner page.
 */
export async function connectTestAccount(page: Page): Promise<void> {
  const response = await page.request.put("/api/staff/payment-account", { data: { provider: "fake" } });
  if (!response.ok()) throw new Error(`Could not connect the test payment account (${response.status()}).`);
}

export async function restoreService(arranged: Arranged): Promise<void> {
  await withOwnerDatabase(async (sql) => {
    await sql`update services set price_minor = ${arranged.previous.priceMinor}, payment_mode = ${arranged.previous.paymentMode}, deposit_minor = ${arranged.previous.depositMinor} where id = ${arranged.serviceId}`;
    // Orders and payments point at the account, so it is switched off rather than removed.
    await sql`update tenant_payment_accounts set status = 'disabled', secret_ciphertext = null, webhook_secret_ciphertext = null where tenant_id = (select tenant_id from services where id = ${arranged.serviceId})`;
  });
}
