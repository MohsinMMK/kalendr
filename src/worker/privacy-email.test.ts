/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import { createFakeEmailProvider } from "../server/messaging/email-fake";
import type { ProviderSendRequest } from "./delivery";
import { createEmailAdapter } from "./email-adapter";
import type { TenantDb } from "./handlers";

const tenantId = "00000000-0000-4000-8000-000000000001";
const patientId = "00000000-0000-4000-8000-000000000003";

const tenant = {
  name: "Lotus Dental Studio", slug: "lotus-dental", email: "front-desk@lotus.example", phone: "+91 20 5555 0100",
  timezone: "Asia/Kolkata", business_type: "dental", terminology: {}, features: {}, logo_id: null,
};

/** Answers the adapter's reads. `patient` is what the customer's row holds now (an erased row holds a placeholder). */
function fakeTenantDb(patient: Record<string, unknown> | null) {
  return ((strings: TemplateStringsArray) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.includes("from tenants")) return Promise.resolve([tenant]);
    if (text.includes("from patients")) return Promise.resolve(patient ? [patient] : []);
    return Promise.resolve([]);
  }) as unknown as TenantDb;
}

const options = { origin: "https://app.kalendr.example", fallbackReplyTo: "help@kalendr.example" };
const send = (tenantDb: TenantDb, templateKey: string, body: unknown, recipient?: { email: string; name: string }): ProviderSendRequest =>
  ({ tenantDb, tenantId, appointmentId: null, patientId, channel: "email", templateKey, body: JSON.stringify(body), idempotencyKey: `email:${templateKey}:1`, recipient });

describe("privacy emails", () => {
  it("sends the one-time download link to the customer's address", async () => {
    const provider = createFakeEmailProvider();
    const db = fakeTenantDb({ first_name: "Priya", email: "priya@example.com" });
    const result = await createEmailAdapter({ provider, ...options }).send(send(db, "privacy.export", { url: "https://app.kalendr.example/api/portal/privacy/export/abc", validDays: 7 }));
    expect(result.status).toBe("sent");
    expect(provider.sent[0]).toMatchObject({ to: "priya@example.com", fromName: "Lotus Dental Studio", idempotencyKey: "email:privacy.export:1" });
    expect(provider.sent[0]!.text).toContain("https://app.kalendr.example/api/portal/privacy/export/abc");
    expect(provider.sent[0]!.text).toMatch(/works once and expires in 7 days/);
  });

  it("writes to the address the handler read, not the cleared row, for an erasure notice", async () => {
    const provider = createFakeEmailProvider();
    const erasedRow = { first_name: "Erased", email: "erased-1@erased.invalid" };
    const result = await createEmailAdapter({ provider, ...options }).send(
      send(fakeTenantDb(erasedRow), "privacy.erasure", { removed: ["Your name and phone number."], kept: ["Payment records, for 8 years."] }, { email: "priya@example.com", name: "Priya" }),
    );
    expect(result.status).toBe("sent");
    expect(provider.sent[0]!.to).toBe("priya@example.com");
    expect(provider.sent[0]!.text).toContain("Hi Priya");
    expect(provider.sent[0]!.text).toContain("Payment records, for 8 years.");
    expect(provider.sent[0]!.text).not.toContain("erased.invalid");
  });

  it("tells the business, at its own address, that a request is overdue", async () => {
    const provider = createFakeEmailProvider();
    const result = await createEmailAdapter({ provider, ...options }).send(
      send(fakeTenantDb(null), "privacy.overdue", { requestKind: "erasure", dueOn: "2027-02-10", staffUrl: "https://app.kalendr.example/dashboard" }, { email: "front-desk@lotus.example", name: "Lotus Dental Studio" }),
    );
    expect(result.status).toBe("sent");
    expect(provider.sent[0]).toMatchObject({ to: "front-desk@lotus.example" });
    expect(provider.sent[0]!.subject).toContain("erasure request is overdue");
  });

  it("rejects a message whose body is not the expected JSON, and an unknown privacy template", async () => {
    const provider = createFakeEmailProvider();
    const db = fakeTenantDb({ first_name: "Priya", email: "priya@example.com" });
    const adapter = createEmailAdapter({ provider, ...options });
    expect(await adapter.send({ ...send(db, "privacy.export", {}), body: "not json" })).toEqual({ status: "rejected", code: "invalid_event" });
    expect(await adapter.send(send(db, "privacy.unknown", {}))).toEqual({ status: "rejected", code: "invalid_event" });
    expect(provider.attempts).toBe(0);
  });
});
