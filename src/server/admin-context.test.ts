import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  preview: false,
  session: null as null | { user: { id: string }; session: { secondFactorAt: Date | null } },
  role: null as null | "support" | "billing" | "super",
  security: { twoFactorEnabled: true, passkeyCount: 0, passwordChosen: true },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error("notFound"); },
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => state.session } }, authIsConfigured: true }));
vi.mock("@/db/client", () => ({ getDatabase: () => null, withTenant: async () => [] }));
vi.mock("./preview-repository", () => ({ isPreviewMode: () => state.preview }));
vi.mock("./staff-security", () => ({ getUserSecurity: async () => state.security }));
vi.mock("./admin/role", () => ({ lookupPlatformRole: async () => state.role }));

import { ApiError } from "./api-error";
import { getAdminContext, requireAdminCapability, requireAdminPageContext, requireAdminStepUp } from "./admin-context";

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

beforeEach(() => {
  state.preview = false;
  state.session = { user: { id: "operator" }, session: { secondFactorAt: hoursAgo(1) } };
  state.role = "support";
  state.security = { twoFactorEnabled: true, passkeyCount: 0, passwordChosen: true };
});
afterEach(() => vi.unstubAllEnvs());

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe("getAdminContext", () => {
  it("gives an operator with a fresh second factor their role", async () => {
    await expect(getAdminContext(new Headers())).resolves.toMatchObject({ userId: "operator", role: "support", preview: false });
  });

  it("answers 404 not_found for a staff member who is not an operator", async () => {
    state.role = null;
    expect(await refusal(getAdminContext(new Headers()))).toMatchObject({ status: 404, code: "not_found" });
  });

  it("answers the same 404 for a visitor with no session", async () => {
    state.session = null;
    expect(await refusal(getAdminContext(new Headers()))).toMatchObject({ status: 404, code: "not_found" });
  });

  it("does not exist in preview mode", async () => {
    state.preview = true;
    expect(await refusal(getAdminContext(new Headers()))).toMatchObject({ status: 404 });
  });

  it("refuses an operator with no second factor enrolled", async () => {
    state.security = { twoFactorEnabled: false, passkeyCount: 0, passwordChosen: true };
    expect(await refusal(getAdminContext(new Headers()))).toMatchObject({ status: 403, code: "second_factor_required" });
  });

  it("counts a passkey as the factor", async () => {
    state.security = { twoFactorEnabled: false, passkeyCount: 1, passwordChosen: true };
    await expect(getAdminContext(new Headers())).resolves.toMatchObject({ role: "support" });
  });

  it("asks for the code when this sign-in has not used it, or used it more than 12 hours ago", async () => {
    state.session = { user: { id: "operator" }, session: { secondFactorAt: null } };
    expect(await refusal(getAdminContext(new Headers()))).toMatchObject({ code: "second_factor_pending" });
    state.session = { user: { id: "operator" }, session: { secondFactorAt: hoursAgo(13) } };
    expect(await refusal(getAdminContext(new Headers()))).toMatchObject({ code: "second_factor_pending" });
  });

  it("answers 404 on another host or from another address when those limits are set, even for an operator", async () => {
    vi.stubEnv("KALENDR_ADMIN_HOST", "admin.example.com");
    expect(await refusal(getAdminContext(new Headers({ host: "www.example.com" })))).toMatchObject({ status: 404 });
    await expect(getAdminContext(new Headers({ host: "admin.example.com" }))).resolves.toMatchObject({ role: "support" });
    vi.stubEnv("KALENDR_ADMIN_IP_ALLOWLIST", "198.51.100.7");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(await refusal(getAdminContext(new Headers({ host: "admin.example.com", "x-forwarded-for": "198.51.100.8" })))).toMatchObject({ status: 404 });
    await expect(getAdminContext(new Headers({ host: "admin.example.com", "x-forwarded-for": "198.51.100.7" }))).resolves.toMatchObject({ role: "support" });
  });
});

describe("requireAdminPageContext", () => {
  it("sends only a visitor with no session to sign in; everyone else gets the 404 page", async () => {
    state.session = null;
    await expect(requireAdminPageContext()).rejects.toThrow("redirect:/sign-in");
    state.session = { user: { id: "operator" }, session: { secondFactorAt: hoursAgo(1) } };
    state.role = null;
    await expect(requireAdminPageContext()).rejects.toThrow("notFound");
    state.preview = true;
    await expect(requireAdminPageContext()).rejects.toThrow("notFound");
  });

  it("sends an operator to the existing second-factor pages", async () => {
    state.role = "super";
    state.security = { twoFactorEnabled: false, passkeyCount: 0, passwordChosen: true };
    await expect(requireAdminPageContext()).rejects.toThrow("redirect:/security/second-factor");
    state.security = { twoFactorEnabled: true, passkeyCount: 0, passwordChosen: true };
    state.session = { user: { id: "operator" }, session: { secondFactorAt: null } };
    await expect(requireAdminPageContext()).rejects.toThrow("redirect:/sign-in/verify");
  });
});

describe("role and step-up checks", () => {
  it("refuses a role without the capability with a 403, and a stale code for write actions", async () => {
    expect(() => requireAdminCapability({ role: "billing" }, "operate")).toThrow(/403|billing/);
    expect(() => requireAdminCapability({ role: "super" }, "manageOperators")).not.toThrow();
    const stale = await getAdminContext(new Headers());
    expect(() => requireAdminStepUp({ ...stale, secondFactorAt: hoursAgo(1) })).toThrow(/code from your authenticator/);
    expect(() => requireAdminStepUp({ ...stale, secondFactorAt: new Date() })).not.toThrow();
  });
});
