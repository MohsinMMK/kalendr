/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TestQueryProvider } from "@/test/query-wrapper";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  verifyTotp: vi.fn(),
  verifyBackupCode: vi.fn(),
  enable: vi.fn(),
  passkeySignIn: vi.fn(),
  addPasskey: vi.fn(),
  listPasskeys: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  revokeSessions: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { passkey: mocks.passkeySignIn },
    signOut: mocks.signOut,
    twoFactor: { verifyTotp: mocks.verifyTotp, verifyBackupCode: mocks.verifyBackupCode, enable: mocks.enable, generateBackupCodes: vi.fn(), disable: vi.fn() },
    passkey: { addPasskey: mocks.addPasskey, listUserPasskeys: mocks.listPasskeys, deletePasskey: vi.fn() },
    listSessions: mocks.listSessions,
    getSession: mocks.getSession,
    revokeSession: mocks.revokeSession,
    revokeOtherSessions: mocks.revokeOtherSessions,
    revokeSessions: mocks.revokeSessions,
  },
}));

import { EnrolSecondFactor } from "./enrol-second-factor";
import { SecurityPanel } from "./security-panel";
import { StepUpProvider, useStepUp } from "./step-up-dialog";
import { VerifySecondFactor } from "./verify-second-factor";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("confirm it's you page", () => {
  it("verifies an authenticator code and continues to the destination", async () => {
    mocks.verifyTotp.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<VerifySecondFactor hasAuthenticator hasPasskey={false} destination="/dashboard" />);
    await user.type(screen.getByLabelText("Authenticator code"), "123 456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(mocks.verifyTotp).toHaveBeenCalledWith({ code: "123456" });
    expect(mocks.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("offers a passkey and a sign out, and shows an error that stays on the page", async () => {
    mocks.passkeySignIn.mockResolvedValue({ error: { status: 400 } });
    const user = userEvent.setup();
    render(<VerifySecondFactor hasAuthenticator={false} hasPasskey destination="/dashboard" />);
    expect(screen.queryByLabelText("Authenticator code")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use a passkey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("passkey was not confirmed");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("second factor enrolment", () => {
  it("walks from choosing, to the key and a first code, to the backup codes that gate Continue", async () => {
    mocks.enable.mockResolvedValue({ data: { totpURI: "otpauth://totp/Kalendr:a%40b.com?secret=ABCD2345&issuer=Kalendr", backupCodes: ["aaaa-1111", "bbbb-2222"] }, error: null });
    mocks.verifyTotp.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<EnrolSecondFactor passwordChosen={false} />);
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Authenticator app" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(mocks.enable).toHaveBeenCalledWith({});
    expect(await screen.findByTestId("totp-secret")).toHaveTextContent("ABCD2345");
    expect(screen.getByRole("img", { name: "QR code for your authenticator app" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Authenticator code"), "654321");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(mocks.verifyTotp).toHaveBeenCalledWith({ code: "654321" });
    expect(await screen.findByText("aaaa-1111")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Continue" });
    expect(next).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "I saved these codes" }));
    expect(next).toBeEnabled();
    await user.click(next);
    expect(mocks.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("asks for the current password first when the person has one", async () => {
    mocks.enable.mockResolvedValue({ error: { code: "INVALID_PASSWORD", status: 400 } });
    const user = userEvent.setup();
    render(<EnrolSecondFactor passwordChosen />);
    await user.click(screen.getByRole("button", { name: "Authenticator app" }));
    await user.type(screen.getByLabelText("Current password"), "my-example-password");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(mocks.enable).toHaveBeenCalledWith({ password: "my-example-password" });
    expect(await screen.findByRole("alert")).toHaveTextContent("That password is not right");
  });
});

describe("step-up dialog", () => {
  function Harness({ action }: { action: () => Promise<string> }) {
    const { runWithStepUp } = useStepUp();
    return <button type="button" onClick={() => void runWithStepUp(action).catch(() => undefined)}>Do it</button>;
  }

  it("asks for a code when the server says so, then tries once more", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { twoFactorEnabled: true, passkeyCount: 0 } }))));
    mocks.verifyTotp.mockResolvedValue({ error: null });
    const action = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("Needs a code"), { code: "step_up_required" }))
      .mockResolvedValueOnce("done");
    const user = userEvent.setup();
    render(<StepUpProvider><Harness action={action} /></StepUpProvider>);
    await user.click(screen.getByRole("button", { name: "Do it" }));
    expect(await screen.findByRole("dialog", { name: "Confirm it's you" })).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText("Authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("does not retry when the person closes the dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { twoFactorEnabled: true, passkeyCount: 0 } }))));
    const action = vi.fn<() => Promise<string>>().mockRejectedValue(Object.assign(new Error("Needs a code"), { code: "step_up_required" }));
    const user = userEvent.setup();
    render(<StepUpProvider><Harness action={action} /></StepUpProvider>);
    await user.click(screen.getByRole("button", { name: "Do it" }));
    await user.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("links to enrolment when a second factor is required", async () => {
    const action = vi.fn<() => Promise<string>>().mockRejectedValue(Object.assign(new Error("No factor"), { code: "second_factor_required" }));
    const user = userEvent.setup();
    render(<StepUpProvider><Harness action={action} /></StepUpProvider>);
    await user.click(screen.getByRole("button", { name: "Do it" }));
    expect(await screen.findByRole("link", { name: "Set up a second factor" })).toHaveAttribute("href", "/security/second-factor");
  });
});

describe("security panel", () => {
  const summary = { twoFactorEnabled: true, passkeyCount: 0, passwordChosen: true, secondFactorRequired: true, policy: { requireSecondFactorForAll: false }, recentlyVerified: true };

  function setup() {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: summary }))));
    mocks.listPasskeys.mockResolvedValue({ data: [], error: null });
    mocks.getSession.mockResolvedValue({ data: { session: { token: "tok-1" } } });
    mocks.listSessions.mockResolvedValue({
      data: [
        { id: "s1", token: "tok-1", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36", ipAddress: "203.0.113.9", createdAt: new Date(), updatedAt: new Date() },
        { id: "s2", token: "tok-2", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0", ipAddress: "198.51.100.4", createdAt: new Date(), updatedAt: new Date() },
      ],
      error: null,
    });
    mocks.revokeSession.mockResolvedValue({ error: null });
    render(<TestQueryProvider><SecurityPanel /></TestQueryProvider>);
  }

  it("lists devices, marks this one, and removes a signed-out device at once", async () => {
    setup();
    expect(await screen.findByText("Chrome on macOS")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out Chrome on macOS" })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out Firefox on Windows" }));
    expect(mocks.revokeSession).toHaveBeenCalledWith({ token: "tok-2" });
    await waitFor(() => expect(screen.queryByText("Firefox on Windows")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeDisabled();
  });

  it("explains why the second factor cannot be turned off and shows the team switch", async () => {
    setup();
    expect(await screen.findByText(/Your role needs a second factor/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Ask everyone on the team for a second factor" })).not.toBeChecked();
    expect(screen.getByText("No passkeys yet. Add one to sign in faster on this device.")).toBeInTheDocument();
  });

  it("shows a retry when the summary cannot load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "x", message: "no" } }), { status: 500 })));
    mocks.listPasskeys.mockResolvedValue({ data: [], error: null });
    mocks.getSession.mockResolvedValue({ data: null });
    mocks.listSessions.mockResolvedValue({ data: [], error: null });
    render(<TestQueryProvider><SecurityPanel /></TestQueryProvider>);
    expect((await screen.findAllByRole("button", { name: "Try again" })).length).toBeGreaterThan(0);
  });
});
