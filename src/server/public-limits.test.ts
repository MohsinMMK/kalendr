import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@/server/logger", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/logger")>();
  const quiet = original.createLogger({ level: "silent" });
  return { ...original, logger: () => Object.assign(Object.create(quiet) as typeof quiet, { warn }) };
});

vi.mock("@/server/clinic-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/clinic-registration")>()),
  isClinicRegistrationOpen: () => true,
  registerClinic: vi.fn(async () => ({ clinicSlug: "new-business" })),
}));

import { POST as createBooking } from "@/app/api/public/appointments/route";
import { POST as registerClinic } from "@/app/api/public/clinics/route";
import { resetPreviewStoreForTests } from "@/server/preview-repository";

// No database here: the limiter counts in memory, as in the preview. Every test uses its own address.
const booking = {
  clinicSlug: "indiranagar-dental",
  patientType: "returning",
  bookingFor: "self",
  locationId: "loc_indiranagar",
  serviceId: "service_cleaning",
  practitionerId: "practitioner_asha",
  slotId: "slot_2026_09_01_0930_asha",
  startsAt: "2026-09-01T09:30:00+05:30",
  endsAt: "2026-09-01T10:15:00+05:30",
  firstName: "Test",
  lastName: "Customer",
  phone: "+91 90000 00000",
  email: "test.customer@example.com",
  preferredChannel: "sms",
  acceptedPrivacyNotice: true,
  messagingConsent: false,
};

let keyNumber = 0;
function post(url: string, body: unknown, address: string, headers: Record<string, string> = {}): Request {
  keyNumber += 1;
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": address,
      "idempotency-key": `limits-test-key-${String(keyNumber).padStart(6, "0")}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

describe("public request limits and bot filters", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    resetPreviewStoreForTests();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses the sixth sign-up from one network in 15 minutes, with Retry-After", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await registerClinic(post("/api/public/clinics", {}, "203.0.113.10"))).status);
    }
    // The first five are counted even though the details are wrong; the sixth is not read at all.
    expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    const refused = await registerClinic(post("/api/public/clinics", {}, "203.0.113.10"));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await errorCode(refused)).toBe("rate_limited");
    expect(statuses[5]).toBe(429);
    // Another network is unaffected, and a client can't dodge by writing its own X-Forwarded-For first.
    expect((await registerClinic(post("/api/public/clinics", {}, "203.0.113.11"))).status).not.toBe(429);
    expect((await registerClinic(post("/api/public/clinics", {}, "198.51.100.99, 203.0.113.10"))).status).toBe(429);
  });

  it("stops scripted booking posts after ten an hour from one network", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      statuses.push((await createBooking(post("/api/public/appointments", { ...booking, email: `bot${attempt}@example.com`, phone: `+91 90000 ${String(10_000 + attempt)}` }, "203.0.113.20"))).status);
    }
    expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
    expect(statuses.slice(10).every((status) => status === 429)).toBe(true);
  });

  it("refuses more than five bookings an hour for one phone number, from any network", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await createBooking(post("/api/public/appointments", { ...booking, email: `same-phone${attempt}@example.com` }, `192.0.2.${attempt + 1}`))).status);
    }
    expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("refuses a filled hidden field and a form sent too fast, without saying why", async () => {
    const trap = await createBooking(post("/api/public/appointments", { ...booking, phone: "+91 90000 70001", companyWebsite: "https://spam.example" }, "203.0.113.30"));
    expect(trap.status).toBe(400);
    expect(await errorCode(trap)).toBe("booking_refused");

    const quick = await createBooking(post("/api/public/appointments", { ...booking, phone: "+91 90000 70002", fillMs: 400 }, "203.0.113.31"));
    expect(quick.status).toBe(400);
    expect(await errorCode(quick)).toBe("booking_refused");

    expect(warn).toHaveBeenCalledWith({ event: "rate_limit.refused", rule: "bot_check.honeypot" }, "request refused");
    expect(warn).toHaveBeenCalledWith({ event: "rate_limit.refused", rule: "bot_check.too_fast" }, "request refused");

    // A person who took their time, and a business server that sends no fill time, both get through.
    const person = await createBooking(post("/api/public/appointments", { ...booking, phone: "+91 90000 70003", fillMs: 45_000 }, "203.0.113.32"));
    expect(person.status).toBe(201);
  });

  it("asks for the person check on a repeat booking from one network when Turnstile is on", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
    const first = await createBooking(post("/api/public/appointments", { ...booking, phone: "+91 90000 80001", fillMs: 30_000 }, "203.0.113.40"));
    expect(first.status).toBe(201);
    const second = await createBooking(post("/api/public/appointments", { ...booking, slotId: "other", phone: "+91 90000 80002", fillMs: 30_000 }, "203.0.113.40"));
    expect(second.status).toBe(400);
    expect(await errorCode(second)).toBe("challenge_required");
  });
});
