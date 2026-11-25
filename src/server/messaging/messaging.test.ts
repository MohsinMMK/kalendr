/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from "vitest";

import { previewAppointment, previewBrand } from "@/emails/_shared/brand";
import { profileWords, resolveBusinessProfile } from "@/lib/terminology";

import { emailSettingsFromEnv } from "./email-config";
import { createFakeEmailProvider } from "./email-fake";
import { createResendEmailProvider, resendBaseUrl } from "./email-resend";
import { emailTemplates, renderEmail, type EmailTemplateName } from "./email-templates";
import { PermanentSendError, senderWithName, TransientSendError, type RenderedMessage } from "./provider";
import { openManageToken, sealManageToken } from "./sealed-link";
import { destinationHash } from "./suppression";

afterEach(() => {
  vi.unstubAllGlobals();
});

const message: RenderedMessage = {
  to: "priya@example.com",
  fromName: "Lotus Dental Studio",
  replyTo: "front-desk@lotus.example",
  subject: "Your booking is confirmed",
  html: "<p>Hello</p>",
  text: "Hello",
  attachments: [{ filename: "appointment.ics", contentType: "text/calendar; charset=utf-8; method=PUBLISH", content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" }],
  idempotencyKey: "email:abc123",
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("email templates", () => {
  const names = Object.keys(emailTemplates) as EmailTemplateName[];

  it("has the customer and account emails, the shared-document email, the workflow email and the booking code", () => {
    expect(names.length).toBeGreaterThanOrEqual(15);
    expect(names).toContain("booking_code");
  });

  it.each(names)("%s renders HTML, a plain-text version and a one-line subject", async (name) => {
    const props = (emailTemplates[name].component as unknown as { PreviewProps: never }).PreviewProps;
    const rendered = await renderEmail(name, props);
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.subject.length).toBeGreaterThan(5);
    expect(rendered.html).toContain("<html");
    expect(rendered.text.length).toBeGreaterThan(20);
    expect(rendered.text).not.toContain("<");
  });

  it("uses the business's name, accent colour, own words, and the manage link in both versions", async () => {
    const words = profileWords(resolveBusinessProfile({ businessType: "salon", terminology: {}, features: {} }));
    const rendered = await renderEmail("booking_confirmed", {
      brand: { ...previewBrand, businessName: "Glow Salon", accentColor: "#aa3366", words },
      customerName: "Priya",
      appointment: previewAppointment,
    });
    expect(rendered.subject).toContain("Glow Salon");
    expect(rendered.html).toContain("#aa3366");
    expect(rendered.html).toContain(previewAppointment.manageUrl!);
    expect(rendered.text).toContain(previewAppointment.manageUrl!);
    expect(rendered.text.toLowerCase()).toContain(words.appointment.toLowerCase());
  });

  it("escapes what a business or customer typed", async () => {
    const rendered = await renderEmail("booking_confirmed", {
      brand: { ...previewBrand, businessName: "<script>alert(1)</script>" },
      customerName: "<img src=x onerror=alert(1)>",
      appointment: previewAppointment,
    });
    expect(rendered.html).not.toContain("<script>alert(1)</script>");
    expect(rendered.html).not.toContain("<img src=x");
  });
});

describe("fake email provider", () => {
  it("sends once per idempotency key and can be told to fail", async () => {
    const provider = createFakeEmailProvider();
    const first = await provider.send(message);
    const again = await provider.send(message);
    expect(again.providerMessageId).toBe(first.providerMessageId);
    expect(provider.sent).toHaveLength(1);
    provider.failNext("transient", "permanent");
    await expect(provider.send({ ...message, idempotencyKey: "email:other" })).rejects.toBeInstanceOf(TransientSendError);
    await expect(provider.send({ ...message, idempotencyKey: "email:other" })).rejects.toBeInstanceOf(PermanentSendError);
    expect(provider.attempts).toBe(4);
  });
});

describe("Resend email provider", () => {
  const provider = () => createResendEmailProvider({ apiKey: "re_test_key", from: "Kalendr <bookings@kalendr.example>", apiUrl: "http://127.0.0.1:3199/emails" });

  it("sends from the business's name with its Reply-To, the calendar file and the idempotency key", async () => {
    const request = vi.fn().mockImplementation(async () => jsonResponse(200, { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }));
    vi.stubGlobal("fetch", request);
    expect(await provider().send(message)).toEqual({ providerMessageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3199/emails");
    expect(new Headers(init.headers).get("idempotency-key")).toBe("email:abc123");
    const body = JSON.parse(String(init.body));
    expect(body.from).toBe('"Lotus Dental Studio" <bookings@kalendr.example>');
    expect(body.reply_to).toBe("front-desk@lotus.example");
    expect(body.to).toEqual(["priya@example.com"]);
    expect(body.text).toBe("Hello");
    expect(body.attachments[0].filename).toBe("appointment.ics");
    expect(Buffer.from(body.attachments[0].content, "base64").toString("utf8")).toContain("BEGIN:VCALENDAR");
  });

  it("treats rate limits, 5xx and network errors as worth retrying, and everything else as permanent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => jsonResponse(429, { name: "rate_limit_exceeded", message: "x", statusCode: 429 })));
    await expect(provider().send(message)).rejects.toMatchObject({ name: "TransientSendError", failureCode: "resend_rate_limit_exceeded" });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => jsonResponse(500, { name: "internal_server_error", message: "x", statusCode: 500 })));
    await expect(provider().send(message)).rejects.toBeInstanceOf(TransientSendError);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    // The SDK turns a network failure into an application_error result; either way it is retried.
    await expect(provider().send(message)).rejects.toBeInstanceOf(TransientSendError);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => jsonResponse(422, { name: "validation_error", message: "Invalid `to` field: priya@example.com", statusCode: 422 })));
    const refused = provider().send(message);
    await expect(refused).rejects.toMatchObject({ name: "PermanentSendError", failureCode: "resend_validation_error" });
    // The provider's message (which can hold the address) never reaches the error.
    await expect(refused).rejects.not.toThrow(/priya/);
  });

  it("accepts either the base URL or the /emails endpoint", () => {
    expect(resendBaseUrl("http://127.0.0.1:3199/emails")).toBe("http://127.0.0.1:3199");
    expect(resendBaseUrl("https://api.resend.com/")).toBe("https://api.resend.com");
  });
});

describe("senderWithName", () => {
  it("strips characters that would break the From header", () => {
    expect(senderWithName('Evil"\r\nBcc: x@y.z <a>', "Kalendr <b@kalendr.example>")).toBe('"EvilBcc: x@y.z a" <b@kalendr.example>');
    expect(senderWithName(undefined, "b@kalendr.example")).toBe("b@kalendr.example");
  });
});

describe("email settings", () => {
  const base = { RESEND_API_KEY: "re_test_key", EMAIL_FROM: "Kalendr <b@kalendr.example>" };

  it("are off without a key and a sender", () => {
    expect(emailSettingsFromEnv({ localOnly: false }, {})).toBeNull();
  });

  it("never reach a real provider from a local run", () => {
    expect(emailSettingsFromEnv({ localOnly: true }, base)).toBeNull();
    expect(emailSettingsFromEnv({ localOnly: true }, { ...base, EMAIL_API_URL: "https://api.resend.com/emails" })).toBeNull();
    expect(emailSettingsFromEnv({ localOnly: true }, { ...base, EMAIL_API_URL: "http://127.0.0.1:3199/emails" })).not.toBeNull();
  });
});

describe("sealed manage links", () => {
  const tenant = "00000000-0000-4000-8000-000000000001";
  const appointment = "00000000-0000-4000-8000-000000000002";

  it("open only on the row they were sealed for", () => {
    const sealed = sealManageToken(tenant, appointment, "manage-token-value", { NODE_ENV: "test" });
    expect(sealed).toMatch(/^l1\./);
    expect(sealed).not.toContain("manage-token-value");
    expect(openManageToken(tenant, appointment, sealed, { NODE_ENV: "test" })).toBe("manage-token-value");
    expect(openManageToken(tenant, "00000000-0000-4000-8000-000000000009", sealed, { NODE_ENV: "test" })).toBeNull();
    const tampered = `${sealed!.slice(0, -2)}${sealed!.endsWith("A") ? "B" : "A"}A`;
    expect(openManageToken(tenant, appointment, tampered, { NODE_ENV: "test" })).toBeNull();
    expect(openManageToken(tenant, appointment, null)).toBeNull();
  });

  it("are not written in production without a records key", () => {
    expect(sealManageToken(tenant, appointment, "x", { NODE_ENV: "production" })).toBeNull();
  });
});

describe("destinationHash", () => {
  it("matches the same address however it is typed, and never contains it", () => {
    const hash = destinationHash("email", " Priya@Example.com ");
    expect(hash).toBe(destinationHash("email", "priya@example.com"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(destinationHash("email", "other@example.com"));
  });
});
