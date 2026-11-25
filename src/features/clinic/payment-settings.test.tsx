/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPaymentPolicy, type MismatchView, type PaymentAccountView, type PaymentSettingsView } from "@/lib/payments";
import { TestQueryProvider } from "@/test/query-wrapper";
import { staffSnapshotFixture } from "@/test/staff-fixture";

const mocks = vi.hoisted(() => ({ verifyTotp: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { passkey: vi.fn() }, signOut: vi.fn(), twoFactor: { verifyTotp: mocks.verifyTotp, verifyBackupCode: vi.fn() }, passkey: { addPasskey: vi.fn() } },
}));

import { PaymentSettings } from "./payment-settings";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";
import { StepUpProvider } from "./step-up-dialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const razorpayAccount: PaymentAccountView = {
  provider: "razorpay", mode: "test", status: "active", keyId: "rzp_test_AbCdEf123456GhIj",
  webhookUrl: "https://kalendr.example/api/webhooks/razorpay/abc", lastCheckedAt: "2026-11-18T09:30:00.000Z",
};
const settings = (patch: Partial<PaymentSettingsView> = {}): PaymentSettingsView => ({
  account: null, policy: { ...defaultPaymentPolicy, version: 3 }, providers: { razorpay: true, stripe: false, fake: true }, ...patch,
});
const mismatch = (patch: Partial<MismatchView> = {}): MismatchView => ({
  id: "mm1", day: "2026-11-17", kind: "amount_differs", providerPaymentId: "pay_123", providerAmountMinor: 50000, ledgerAmountMinor: 40000, resolved: false, ...patch,
});

type Req = { url: string; method: string; body?: Record<string, unknown> };
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const failure = (status: number, code: string, message: string, fieldErrors?: Record<string, string[]>) => new Response(JSON.stringify({ error: { code, message, fieldErrors } }), { status });

function setup(handler: (request: Req, count: number) => Response | Promise<Response> | undefined, options: { stepUp?: boolean } = {}) {
  const requests: Req[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/staff/snapshot") return json(staffSnapshotFixture);
    if (url === "/api/staff/security") return json({ twoFactorEnabled: true, passkeyCount: 0 });
    const request: Req = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    const count = requests.filter((entry) => entry.url === url && entry.method === request.method).length;
    return handler(request, count) ?? json({});
  }));
  const body = <StaffSnapshotProvider role="owner"><PaymentSettings /></StaffSnapshotProvider>;
  render(<TestQueryProvider>{options.stepUp ? <StepUpProvider>{body}</StepUpProvider> : body}</TestQueryProvider>);
  return requests;
}

const quiet = (request: Req) => (request.url === "/api/staff/payments/mismatches" ? json([]) : undefined);

describe("payment settings states", () => {
  it("shows a loading state, then the full screen", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    setup((request) => (request.url === "/api/staff/payment-settings" ? held.then(() => json(settings({ account: razorpayAccount }))) : quiet(request)));
    expect(await screen.findByRole("status", { name: "Loading payment settings" })).toBeInTheDocument();
    release();
    expect(await screen.findByText("Razorpay")).toBeInTheDocument();
    expect(screen.getByText("Cancellations and refunds")).toBeInTheDocument();
  });

  it("says what went wrong and loads again when asked", async () => {
    const user = userEvent.setup();
    setup((request, count) => {
      if (request.url !== "/api/staff/payment-settings") return quiet(request);
      return count === 1 ? failure(500, "error", "The payment service is not answering.") : json(settings());
    });
    expect(await screen.findByText("The payment service is not answering.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No payment account yet")).toBeInTheDocument();
  });

  it("with no account, offers Razorpay and the test account, and hides Stripe unless it is on", async () => {
    setup((request) => (request.url === "/api/staff/payment-settings" ? json(settings()) : quiet(request)));
    expect(await screen.findByText("No payment account yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use the built-in test account" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect with Stripe" })).not.toBeInTheDocument();
    // Nothing about "needs a look" when there is nothing to see and no account.
    expect(screen.queryByText("Needs a look")).not.toBeInTheDocument();
  });

  it("hides the test account when it is not on offer and links Stripe when it is", async () => {
    setup((request) => (request.url === "/api/staff/payment-settings" ? json(settings({ providers: { razorpay: true, stripe: true, fake: false } })) : quiet(request)));
    const link = await screen.findByRole("link", { name: "Connect with Stripe" });
    expect(link).toHaveAttribute("href", "/api/staff/payment-account/stripe/connect");
    expect(screen.queryByRole("button", { name: "Use the built-in test account" })).not.toBeInTheDocument();
  });

  it("shows a connected test account with the webhook address and never the secret", async () => {
    setup((request) => (request.url === "/api/staff/payment-settings" ? json(settings({ account: razorpayAccount })) : quiet(request)));
    expect(await screen.findByText("Test")).toBeInTheDocument();
    expect(screen.getByText(/No real money moves/)).toBeInTheDocument();
    expect(screen.getByText("rzp_test_••••GhIj")).toBeInTheDocument();
    expect(screen.getByLabelText("Webhook address")).toHaveValue(razorpayAccount.webhookUrl);
    expect(screen.queryByLabelText("Key secret")).not.toBeInTheDocument();
    expect(await screen.findByText("Everything matches. Nothing needs a look.")).toBeInTheDocument();
  });

  it("partial: the account shows even when the mismatch list fails, with its own retry", async () => {
    setup((request) => {
      if (request.url === "/api/staff/payment-settings") return json(settings({ account: razorpayAccount }));
      if (request.url === "/api/staff/payments/mismatches") return failure(500, "error", "Could not check.");
      return undefined;
    });
    expect(await screen.findByText("Razorpay")).toBeInTheDocument();
    expect(await screen.findByText("Could not check.")).toBeInTheDocument();
  });
});

describe("connecting an account", () => {
  it("sends the Razorpay keys, shows server field errors beside the field, and keeps secrets hidden", async () => {
    const user = userEvent.setup();
    const requests = setup((request) => {
      if (request.url === "/api/staff/payment-settings") return json(settings());
      if (request.url === "/api/staff/payment-account" && request.method === "PUT") return failure(422, "invalid_keys", "Razorpay did not accept these keys.", { keySecret: ["Razorpay did not accept this secret."] });
      return quiet(request);
    });
    await screen.findByText("No payment account yet");
    expect(screen.getByLabelText("Key secret")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Webhook secret")).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("Key id"), "rzp_test_AbCdEf123456GhIj");
    await user.type(screen.getByLabelText("Key secret"), "secret-value-1");
    await user.type(screen.getByLabelText("Webhook secret"), "hook-value-1");
    await user.click(screen.getByRole("button", { name: "Connect Razorpay" }));
    expect(await screen.findByText("Razorpay did not accept this secret.")).toBeInTheDocument();
    const put = requests.find((request) => request.method === "PUT");
    expect(put?.body).toEqual({ provider: "razorpay", keyId: "rzp_test_AbCdEf123456GhIj", keySecret: "secret-value-1", webhookSecret: "hook-value-1" });
  });

  it("checks the key id before sending anything", async () => {
    const user = userEvent.setup();
    const requests = setup((request) => (request.url === "/api/staff/payment-settings" ? json(settings()) : quiet(request)));
    await screen.findByText("No payment account yet");
    await user.type(screen.getByLabelText("Key id"), "not-a-key");
    await user.click(screen.getByRole("button", { name: "Connect Razorpay" }));
    expect(await screen.findByText(/does not look like a Razorpay key id/)).toBeInTheDocument();
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it("uses the built-in test account and then shows it as connected", async () => {
    const user = userEvent.setup();
    let connected = false;
    const requests = setup((request) => {
      if (request.url === "/api/staff/payment-settings") return json(settings({ account: connected ? { ...razorpayAccount, provider: "fake", keyId: "test-account", webhookUrl: "" } : null }));
      if (request.url === "/api/staff/payment-account" && request.method === "PUT") { connected = true; return json({ ...razorpayAccount, provider: "fake", keyId: "test-account", webhookUrl: "" }); }
      return quiet(request);
    });
    await user.click(await screen.findByRole("button", { name: "Use the built-in test account" }));
    expect(await screen.findByText("Built-in test account")).toBeInTheDocument();
    expect(requests.find((request) => request.method === "PUT")?.body).toEqual({ provider: "fake" });
  });

  it("asks for a fresh code when the server wants one, then sends the request again", async () => {
    mocks.verifyTotp.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    let connected = false;
    const requests = setup((request, count) => {
      if (request.url === "/api/staff/payment-settings") return json(settings({ account: connected ? razorpayAccount : null }));
      if (request.url === "/api/staff/payment-account" && request.method === "PUT") {
        if (count === 1) return failure(403, "step_up_required", "Confirm it is you first.");
        connected = true;
        return json(razorpayAccount);
      }
      return quiet(request);
    }, { stepUp: true });
    await user.click(await screen.findByRole("button", { name: "Use the built-in test account" }));
    expect(await screen.findByRole("dialog", { name: "Confirm it's you" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("rzp_test_••••GhIj")).toBeInTheDocument();
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(2);
  });

  it("says nothing was changed when the code is not given", async () => {
    const user = userEvent.setup();
    setup((request) => {
      if (request.url === "/api/staff/payment-settings") return json(settings());
      if (request.url === "/api/staff/payment-account" && request.method === "PUT") return failure(403, "step_up_required", "Confirm it is you first.");
      return quiet(request);
    }, { stepUp: true });
    await user.click(await screen.findByRole("button", { name: "Use the built-in test account" }));
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(await screen.findByText(/Nothing was changed/)).toBeInTheDocument();
  });

  it("disconnects only after a confirmation", async () => {
    const user = userEvent.setup();
    let connected = true;
    const requests = setup((request) => {
      if (request.url === "/api/staff/payment-settings") return json(settings({ account: connected ? razorpayAccount : null }));
      if (request.url === "/api/staff/payment-account" && request.method === "DELETE") { connected = false; return json({}); }
      return quiet(request);
    });
    await user.click(await screen.findByRole("button", { name: "More payment account actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Disconnect/ }));
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("No payment account yet")).toBeInTheDocument();
  });
});

describe("policy", () => {
  it("writes the wording as the settings change and saves with the version it loaded", async () => {
    const user = userEvent.setup();
    const requests = setup((request) => {
      if (request.url === "/api/staff/payment-settings") return json(settings());
      if (request.url === "/api/staff/payment-policy") return json({ freeCancelHours: 48, afterWindowRule: "no_refund", noShowRule: "deposit", version: 4 });
      return quiet(request);
    });
    // 24 hours is shown as 1 day.
    const amount = await screen.findByLabelText("Free cancellation until");
    expect(amount).toHaveValue("1");
    expect(screen.getByText(/at least 1 day before it starts/)).toBeInTheDocument();
    expect(screen.getByText(/You pay ₹200 now as a deposit/)).toBeInTheDocument();
    await user.clear(amount);
    await user.type(amount, "2");
    expect(screen.getByText(/at least 2 days before it starts/)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: /does not come/ }));
    await user.click(await screen.findByRole("option", { name: "Keep everything paid" }));
    expect(screen.getByText(/everything you paid is kept/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(requests.some((request) => request.url === "/api/staff/payment-policy")).toBe(true));
    expect(requests.find((request) => request.url === "/api/staff/payment-policy")).toMatchObject({ method: "PUT", body: { freeCancelHours: 48, afterWindowRule: "no_refund", noShowRule: "everything", version: 3 } });
  });

  it("rejects a number it cannot use and offers their version after a conflict", async () => {
    const user = userEvent.setup();
    let version = 3;
    const requests = setup((request) => {
      if (request.url === "/api/staff/payment-settings") return json(settings({ policy: { ...defaultPaymentPolicy, freeCancelHours: 12, version } }));
      if (request.url === "/api/staff/payment-policy") { version = 4; return failure(409, "version_conflict", "Changed by someone else."); }
      return quiet(request);
    });
    const amount = await screen.findByLabelText("Free cancellation until");
    await user.clear(amount);
    await user.type(amount, "abc");
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    expect(await screen.findByText(/Enter a whole number/)).toBeInTheDocument();
    expect(requests.some((request) => request.url === "/api/staff/payment-policy")).toBe(false);
    await user.clear(amount);
    await user.type(amount, "6");
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    expect(await screen.findByText("Someone else changed this policy")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load their version" }));
    await waitFor(() => expect(screen.queryByText("Someone else changed this policy")).not.toBeInTheDocument());
  });
});

describe("payments that need a look", () => {
  it("lists them and resolves one with a note", async () => {
    const user = userEvent.setup();
    let resolved = false;
    const requests = setup((request) => {
      if (request.url === "/api/staff/payment-settings") return json(settings({ account: razorpayAccount }));
      if (request.url === "/api/staff/payments/mismatches") return json([mismatch({ resolved })]);
      if (request.url === "/api/staff/payments/mismatches/mm1/resolve") { resolved = true; return json({}); }
      return undefined;
    });
    expect(await screen.findByText("The amounts do not match")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Resolve/ }));
    await user.type(await screen.findByLabelText(/Note/), "Refunded by hand");
    await user.click(screen.getByRole("button", { name: "Mark as sorted out" }));
    expect(await screen.findByText("Sorted out")).toBeInTheDocument();
    expect(requests.find((request) => request.url.endsWith("/resolve"))).toMatchObject({ method: "POST", body: { note: "Refunded by hand" } });
  });
});
