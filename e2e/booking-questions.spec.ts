import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { signIn, unique } from "./support/journey";

/**
 * Feature 40: a question that appears only for one answer drops a crafted answer; a phone-only service
 * books without an email; a guest gets the confirmation without the manage link; the email check asks for
 * a code that arrives by email, accepts it after wrong tries, and the proof books once.
 *
 * The worker runs in local_capture mode against the capture server, so nothing reaches a real provider.
 */
const captureUrl = process.env.KALENDR_CAPTURE_URL ?? "http://127.0.0.1:3199";
const appUrl = process.env.KALENDR_APP_URL ?? "http://localhost:3100";
const DAY = 86_400_000;

/** Public bookings are limited per address (ten an hour); each journey uses an address of its own. */
function addressHeaders(testInfo: { project: { name: string } }, last: number): Record<string, string> {
  return { "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? last + 100 : last}` };
}

function runtimeEnv(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(resolve(process.cwd(), process.env.KALENDR_E2E_STATE_DIR ?? ".e2e", "runtime.env"), "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

let worker: ChildProcess | undefined;
test.beforeAll(() => {
  const runtime = runtimeEnv();
  worker = spawn(resolve(process.cwd(), "node_modules/.bin/tsx"), ["--tsconfig", "e2e/support/tsconfig.worker.json", "src/worker/run.ts"], {
    cwd: process.cwd(), stdio: "ignore",
    env: {
      PATH: process.env.PATH, NODE_ENV: "development", KALENDR_WORKER_MODE: "local_capture", KALENDR_PREVIEW_MODE: "false",
      DATABASE_URL: runtime.DATABASE_URL, WORKER_DATABASE_URL: runtime.WORKER_DATABASE_URL, KALENDR_RECORDS_KEY: runtime.KALENDR_RECORDS_KEY,
      BETTER_AUTH_SECRET: runtime.BETTER_AUTH_SECRET, BETTER_AUTH_URL: appUrl, EMAIL_FROM: "Kalendr Tests <tests@example.com>",
      RESEND_API_KEY: "e2e-capture-only", EMAIL_API_URL: `${captureUrl}/emails`, LOG_LEVEL: "warn",
    },
  });
});
test.afterAll(() => { worker?.kill("SIGTERM"); });

async function emailsTo(address: string): Promise<Array<{ subject: string; text: string; html: string }>> {
  return (await (await fetch(`${captureUrl}/messages?to=${encodeURIComponent(address)}`)).json()) as Array<{ subject: string; text: string; html: string }>;
}

async function makeService(request: APIRequestContext, name: string, intake: object) {
  const created = await request.post("/api/staff/services", { data: { name, description: "Made by the booking questions journey.", durationMinutes: 30 } });
  expect(created.status()).toBe(201);
  const { serviceId } = (await created.json()).data as { serviceId: string };
  const setup = (await (await request.get(`/api/staff/services/${serviceId}`)).json()).data;
  const saved = await request.patch(`/api/staff/services/${serviceId}`, { data: { expectedVersion: setup.version, intake } });
  expect(saved.status()).toBe(200);
  return { serviceId, locationId: setup.basics.locationIds[0] as string };
}

async function openings(request: APIRequestContext, ids: { serviceId: string; locationId: string }) {
  const from = new Date(Date.now() + 3 * DAY);
  const response = await request.get("/api/public/availability?" + new URLSearchParams({
    clinicSlug: "lotus-dental", locationId: ids.locationId, serviceId: ids.serviceId, practitionerId: "first_available",
    from: from.toISOString(), to: new Date(from.getTime() + 3 * DAY).toISOString(),
  }));
  return (await response.json()).data.slots as Array<{ id: string; startsAt: string; endsAt: string; practitionerId: string }>;
}

/** Starts at least an hour apart, so one booking never gets in the way of another. */
function spaced<T extends { startsAt: string }>(slots: T[], count: number): T[] {
  const picked: T[] = [];
  for (const slot of slots) {
    if (picked.length === 0 || Date.parse(slot.startsAt) >= Date.parse(picked[picked.length - 1]!.startsAt) + 3_600_000) picked.push(slot);
    if (picked.length === count) break;
  }
  expect(picked).toHaveLength(count);
  return picked;
}

function bookingBody(ids: { serviceId: string; locationId: string }, slot: { id: string; startsAt: string; endsAt: string; practitionerId: string }, extra: object) {
  return {
    clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self", locationId: ids.locationId, serviceId: ids.serviceId, practitionerId: slot.practitionerId,
    slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, firstName: "Questions", lastName: `Journey${unique()}`,
    phone: `+91 98450 ${String(Math.floor(Math.random() * 90_000) + 10_000)}`, email: `q.${unique()}@example.com`, preferredChannel: "email",
    acceptedPrivacyNotice: true, messagingConsent: false, origin: { channel: "hosted" }, ...extra,
  };
}

test("conditions drop a crafted answer, phone-only books without an email, and a guest gets the confirmation", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const headers = addressHeaders(testInfo, 41);
  await page.context().setExtraHTTPHeaders(headers);
  await signIn(page, "kalendr.owner@example.com");
  const suffix = unique();
  const plain = await makeService(page.request, `Questions journey ${suffix}`, { contactMode: "email_or_phone", allowGuests: true, maxGuests: 2, verifyEmail: false });
  const phone = await makeService(page.request, `Phone journey ${suffix}`, { contactMode: "phone_only", allowGuests: false, maxGuests: 1, verifyEmail: false });
  const form = await page.request.post("/api/staff/forms", {
    data: {
      name: `Questions form ${suffix}`, description: "", isActive: true, appliesToAll: false, serviceIds: [plain.serviceId],
      fields: [
        { id: "visited", type: "yes_no", label: "Have you visited before?", required: true },
        { id: "heard", type: "short_text", label: "How did you hear about us?", required: true, showWhen: [{ fieldId: "visited", operator: "equals", value: "no" }] },
        { id: "campaign", type: "short_text", label: "Campaign", required: false, hidden: true, prefillKey: "campaign" },
      ],
    },
  });
  expect(form.status()).toBe(201);

  const slots = spaced(await openings(page.request, plain), 3);
  const book = (ids: typeof plain, slot: typeof slots[number], extra: object) => page.request.post("/api/public/appointments", { headers: { "Idempotency-Key": crypto.randomUUID(), ...headers }, data: bookingBody(ids, slot, extra) });

  // "Yes" to the first question hides the second; a crafted answer to it is not kept, the hidden campaign is.
  const guestEmail = `guest.${suffix}@example.com`;
  const customerEmail = `couple.${suffix}@example.com`;
  const first = await book(plain, slots[0]!, { email: customerEmail, guests: [guestEmail], formAnswers: { visited: true, heard: "crafted", campaign: "diwali" } });
  expect(first.status()).toBe(201);
  const bad = await book(plain, slots[1]!, { formAnswers: { visited: false } });
  expect(bad.status()).toBe(422);

  // The customer and the guest both get a confirmation; only the customer's has the manage link.
  await expect.poll(async () => (await emailsTo(customerEmail)).length, { timeout: 45_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await emailsTo(guestEmail)).length, { timeout: 45_000 }).toBeGreaterThan(0);
  expect((await emailsTo(customerEmail))[0]!.text).toContain("/manage/");
  expect((await emailsTo(guestEmail))[0]!.text).not.toContain("/manage/");

  // A phone-only service books with no email, and refuses a booking with no phone.
  const phoneSlots = spaced(await openings(page.request, phone), 2);
  const withoutEmail = await book(phone, phoneSlots[0]!, { email: "" });
  expect(withoutEmail.status()).toBe(201);
  const withoutPhone = await book(phone, phoneSlots[1]!, { phone: "" });
  expect(withoutPhone.status()).toBe(422);
});

test("the email check wants a code that arrives by email; three wrong tries then the right one books once", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const headers = addressHeaders(testInfo, 42);
  await page.context().setExtraHTTPHeaders(headers);
  await signIn(page, "kalendr.owner@example.com");
  const checked = await makeService(page.request, `Checked journey ${unique()}`, { contactMode: "email_required", allowGuests: false, maxGuests: 1, verifyEmail: true });
  const slots = spaced(await openings(page.request, checked), 2);
  const email = `check.${unique()}@example.com`;
  const book = (slot: typeof slots[number], extra: object) => page.request.post("/api/public/appointments", { headers: { "Idempotency-Key": crypto.randomUUID(), ...headers }, data: bookingBody(checked, slot, { email, ...extra }) });

  // No code, no booking.
  const refused = await book(slots[0]!, {});
  expect(refused.status()).toBe(422);
  expect((await refused.json()).error.code).toBe("email_not_verified");

  const sent = await page.request.post("/api/public/email-check", { headers, data: { action: "send", clinicSlug: "lotus-dental", serviceId: checked.serviceId, email } });
  expect(sent.status()).toBe(200);
  await expect.poll(async () => (await emailsTo(email)).length, { timeout: 45_000 }).toBe(1);
  const code = (await emailsTo(email))[0]!.text.match(/\b(\d{6})\b/)![1]!;
  const wrong = code === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await page.request.post("/api/public/email-check", { headers, data: { action: "verify", clinicSlug: "lotus-dental", email, code: wrong } });
    expect(response.status()).toBe(400);
  }
  const verified = await page.request.post("/api/public/email-check", { headers, data: { action: "verify", clinicSlug: "lotus-dental", email, code } });
  expect(verified.status()).toBe(200);
  const proof = (await verified.json()).data.proof as string;
  expect((await book(slots[0]!, { emailProof: proof })).status()).toBe(201);
  // The proof is used up.
  expect((await book(slots[1]!, { emailProof: proof })).status()).toBe(422);
});
