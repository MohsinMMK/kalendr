import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ getDatabase: () => ({}), withTenant: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authIsConfigured: true }));
vi.mock("./preview-repository", () => ({ isPreviewMode: () => false }));

import { isClinicRegistrationOpen } from "./clinic-registration";

describe("public owner registration deployment gate", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KALENDR_ALLOW_CLINIC_REGISTRATION", "");
    vi.stubEnv("BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION", "true");
    vi.stubEnv("RESEND_API_KEY", "test-provider-key");
    vi.stubEnv("EMAIL_FROM", "Kalendr <kalendr@example.com>");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires explicit registration authorization in production", () => {
    expect(isClinicRegistrationOpen()).toBe(false);
    vi.stubEnv("KALENDR_ALLOW_CLINIC_REGISTRATION", "true");
    expect(isClinicRegistrationOpen()).toBe(true);
  });

  it("does not allow unverified owners in production", () => {
    vi.stubEnv("KALENDR_ALLOW_CLINIC_REGISTRATION", "true");
    vi.stubEnv("BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION", "false");
    expect(isClinicRegistrationOpen()).toBe(false);
  });

  it("requires the configured email provider and sender", () => {
    vi.stubEnv("KALENDR_ALLOW_CLINIC_REGISTRATION", "true");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(isClinicRegistrationOpen()).toBe(false);
    vi.stubEnv("RESEND_API_KEY", "test-provider-key");
    vi.stubEnv("EMAIL_FROM", "");
    expect(isClinicRegistrationOpen()).toBe(false);
  });

  it("honours an explicit closed gate during local development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isClinicRegistrationOpen()).toBe(true);
    vi.stubEnv("KALENDR_ALLOW_CLINIC_REGISTRATION", "false");
    expect(isClinicRegistrationOpen()).toBe(false);
  });
});
