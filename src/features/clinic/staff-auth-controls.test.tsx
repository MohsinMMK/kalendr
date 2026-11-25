/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  signIn: vi.fn(),
  social: vi.fn(),
  magicLink: vi.fn(),
  passkey: vi.fn(),
  verifyTotp: vi.fn(),
  verifyBackupCode: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: mocks.signIn, social: mocks.social, magicLink: mocks.magicLink, passkey: mocks.passkey },
    twoFactor: { verifyTotp: mocks.verifyTotp, verifyBackupCode: mocks.verifyBackupCode },
  },
}));
import { StaffSignIn, signInErrorText } from "./staff-auth-controls";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("staff sign-in form", () => {
  it("labels both fields, toggles password visibility, and submits with Enter", async () => {
    mocks.signIn.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<StaffSignIn />);
    await user.type(screen.getByLabelText("Work email"), "staff@example.com");
    const password = screen.getByLabelText("Password");
    await user.type(password, "a-long-example-password");
    expect(password).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument();
    expect(mocks.signIn).not.toHaveBeenCalled();
    await user.type(password, "{Enter}");
    expect(mocks.signIn).toHaveBeenCalledWith({
      email: "staff@example.com",
      password: "a-long-example-password",
      callbackURL: "/dashboard",
    });
    // Better Auth loads the page itself; a second navigation from the form would race it.
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("shows a rejected sign-in as an alert", async () => {
    mocks.signIn.mockResolvedValue({ error: { code: "INVALID" } });
    const user = userEvent.setup();
    render(<StaffSignIn />);
    await user.type(screen.getByLabelText("Work email"), "staff@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not sign in.");
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});

describe("staff sign-in options", () => {
  it("shows only the providers that are turned on", () => {
    render(<StaffSignIn providers={{ google: true, microsoft: false }} />);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with Microsoft" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a sign-in link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with a passkey" })).toBeInTheDocument();
  });

  it("starts a Google sign-in that comes back to this page on failure", async () => {
    mocks.social.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<StaffSignIn providers={{ google: true, microsoft: true }} />);
    await user.click(screen.getByRole("button", { name: "Continue with Microsoft" }));
    expect(mocks.social).toHaveBeenCalledWith({ provider: "microsoft", callbackURL: "/dashboard", errorCallbackURL: "/sign-in" });
  });

  it("gives the same message for a link whether or not the email has access", async () => {
    const user = userEvent.setup();
    render(<StaffSignIn />);
    mocks.magicLink.mockResolvedValueOnce({ error: null });
    await user.type(screen.getByLabelText("Work email"), "staff@example.com");
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    const message = "If that email has access, we've sent a link. It works once and expires in 10 minutes.";
    expect(await screen.findByRole("status")).toHaveTextContent(message);
    mocks.magicLink.mockResolvedValueOnce({ error: { status: 404, message: "no such user" } });
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(await screen.findByRole("status")).toHaveTextContent(message);
    expect(screen.queryByText("no such user")).not.toBeInTheDocument();
  });

  it("says when too many links were asked for", async () => {
    mocks.magicLink.mockResolvedValue({ error: { status: 429 } });
    const user = userEvent.setup();
    render(<StaffSignIn />);
    await user.type(screen.getByLabelText("Work email"), "staff@example.com");
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many sign-in attempts");
  });

  it("asks for a code in place when the password sign-in needs a second step", async () => {
    mocks.signIn.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    mocks.verifyTotp.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<StaffSignIn />);
    await user.type(screen.getByLabelText("Work email"), "staff@example.com");
    await user.type(screen.getByLabelText("Password"), "a-long-example-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(mocks.replace).not.toHaveBeenCalled();
    await user.type(await screen.findByLabelText("Authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(mocks.verifyTotp).toHaveBeenCalledWith({ code: "123456" });
    expect(mocks.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("accepts a backup code instead and keeps the person on the code step after a wrong one", async () => {
    mocks.signIn.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    mocks.verifyBackupCode.mockResolvedValueOnce({ error: { status: 400 } }).mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();
    render(<StaffSignIn />);
    await user.type(screen.getByLabelText("Work email"), "staff@example.com");
    await user.type(screen.getByLabelText("Password"), "a-long-example-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(await screen.findByRole("button", { name: "Use a backup code" }));
    await user.type(screen.getByLabelText("Backup code"), "abcd-1234");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That backup code did not work");
    expect(mocks.replace).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(mocks.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("explains an error the provider sent back", () => {
    expect(signInErrorText("signup_disabled")).toBe("Ask your manager to invite you.");
    expect(signInErrorText("NO_ACTIVE_MEMBERSHIP")).toBe("Ask your manager to invite you.");
    expect(signInErrorText("SIGN_UP_DISABLED")).toBe("Ask your manager to invite you.");
    expect(signInErrorText("unable_to_link_account")).toBe("Ask your manager to invite you.");
    expect(signInErrorText("account_not_linked")).toBe("Ask your manager to invite you.");
    expect(signInErrorText("something_else")).toBe("Could not sign in. Try again.");
    expect(signInErrorText(null)).toBe("");
    render(<StaffSignIn errorCode="signup_disabled" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Ask your manager to invite you.");
  });
});
