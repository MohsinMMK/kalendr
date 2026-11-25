/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  signInEmail: vi.fn(),
  signInSocial: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { email: mocks.signInEmail, social: mocks.signInSocial } },
}));
import { StartClinicForm } from "./start-clinic-form";

type Reply = { status?: number; body: unknown };
type Route = (url: string, init: RequestInit) => Reply | undefined;

/** A fake server for /start: the sign-up check, then registration. Each test changes only what it needs. */
function server(overrides: { proof?: unknown; verify?: Reply; register?: Reply } = {}) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const routes: Route = (url, init) => {
    const method = init.method ?? "GET";
    if (url === "/api/public/sign-up" && method === "GET") return { body: { data: overrides.proof ?? null } };
    if (url === "/api/public/sign-up" && method === "DELETE") return { body: { data: null } };
    if (url === "/api/public/sign-up" && method === "POST") {
      const body = JSON.parse(String(init.body)) as { action: string };
      if (body.action === "send") return { body: { data: { sent: true, expiresInMinutes: 10 } } };
      return overrides.verify ?? { body: { data: { verified: true } } };
    }
    if (url === "/api/public/clinics") return overrides.register ?? { body: { data: { slug: "lotus-dental" } } };
    return undefined;
  };
  const request = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    const reply = routes(url, init);
    if (!reply) throw new Error(`Unexpected request: ${url}`);
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body } as Response;
  });
  vi.stubGlobal("fetch", request);
  return { request, calls, writes: () => calls.filter((call) => call.method !== "GET") };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function confirmEmail(user: ReturnType<typeof userEvent.setup>, email = "owner@example.com") {
  await user.type(screen.getByLabelText("Work email"), email);
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  await screen.findByRole("heading", { name: "Check your email" });
  await user.click(screen.getByRole("textbox", { name: "Six-digit code" }));
  await user.keyboard("123456");
  await screen.findByRole("heading", { name: "Choose a password" });
}

async function choosePassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Password"), "a-long-example-password");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "What kind of business?" });
}

async function nameBusiness(user: ReturnType<typeof userEvent.setup>, kind: RegExp, businessName: string, ownerName?: string) {
  await user.click(screen.getByRole("radio", { name: kind }));
  await screen.findByRole("heading", { name: /^Name your / });
  await user.type(screen.getByLabelText(/name$/, { selector: "#clinic-name" }), businessName);
  if (ownerName) await user.type(screen.getByLabelText("Your full name"), ownerName);
}

describe("start: sign up first, then the business", () => {
  it("starts with the account: Google, Microsoft or an email, and nothing else", async () => {
    server();
    render(<StartClinicForm providers={{ google: true, microsoft: true }} />);
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue with Google/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue with Microsoft/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/phone/i)).not.toBeInTheDocument();
    // No step counter: each screen is one short question.
    expect(document.body.textContent).not.toMatch(/step \d+ of \d+/i);
  });

  it("hides the provider buttons when none are set up", () => {
    server();
    render(<StartClinicForm providers={{ google: false, microsoft: false }} />);
    expect(screen.queryByRole("button", { name: /Continue with Google/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
  });

  it("checks the email with a code, then asks for a password, the kind and the name, and lands on the dashboard", async () => {
    const api = server();
    mocks.signInEmail.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<StartClinicForm />);
    await confirmEmail(user);
    expect(api.writes().map((call) => call.body?.action)).toEqual(["send", "verify"]);
    expect(api.writes()[1]?.body).toMatchObject({ email: "owner@example.com", code: "123456" });
    await choosePassword(user);
    await nameBusiness(user, /^Dental/, "Lotus Dental", "Meera Iyer");
    await user.click(screen.getByRole("button", { name: "Create clinic" }));
    await waitFor(() => expect(mocks.signInEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "owner@example.com", callbackURL: "/dashboard" })));
    // Better Auth loads the dashboard itself; the form does not navigate as well.
    expect(mocks.replace).not.toHaveBeenCalled();
    const registration = api.calls.find((call) => call.url === "/api/public/clinics")?.body;
    expect(registration).toMatchObject({
      template: "dental",
      businessType: "dental",
      clinicName: "Lotus Dental",
      slug: "lotus-dental",
      email: "owner@example.com",
      password: "a-long-example-password",
      // The owner takes bookings unless they turn it off, so a test booking is possible at once.
      ownerPractices: true,
      practice: { name: "Meera Iyer", title: "Dentist" },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(mocks.signInEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "owner@example.com" }));
  });

  it("puts the cursor in the code boxes and clears a wrong code", async () => {
    server({ verify: { status: 400, body: { error: { code: "invalid_code", message: "That code isn't right or has expired." } } } });
    const user = userEvent.setup();
    render(<StartClinicForm />);
    await user.type(screen.getByLabelText("Work email"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Continue with email" }));
    await screen.findByRole("heading", { name: "Check your email" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Six-digit code" })).toHaveFocus());
    await user.keyboard("000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't right");
    expect(screen.getByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Resend code in \d+s/ })).toBeDisabled();
  });

  it("picks up a Google sign-up after the redirect: no password, the name filled in, signed in with Google", async () => {
    const api = server({ proof: { email: "asha@example.com", method: "google", name: "Asha Rao" } });
    mocks.signInSocial.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<StartClinicForm providers={{ google: true, microsoft: false }} />);
    await screen.findByRole("heading", { name: "What kind of business?" });
    await nameBusiness(user, /^Salon/, "Style Studio");
    expect(screen.getByLabelText("Your full name")).toHaveValue("Asha Rao");
    // The salon's own words, nothing clinical.
    expect(document.body.textContent).not.toMatch(/\b(patients?|clinic|doctor|medical)\b/i);
    await user.click(screen.getByRole("button", { name: "Create salon" }));
    await waitFor(() => expect(mocks.signInSocial).toHaveBeenCalledWith(expect.objectContaining({ provider: "google", callbackURL: "/dashboard" })));
    const registration = api.calls.find((call) => call.url === "/api/public/clinics")?.body;
    expect(registration).toMatchObject({ template: "salon", businessType: "wellness", email: "asha@example.com", clinicName: "Style Studio" });
    expect(registration).not.toHaveProperty("password");
  });

  it("names each kind of business in its own words", async () => {
    server({ proof: { email: "leo@example.com", method: "google", name: "Leo Mathew" } });
    const user = userEvent.setup();
    render(<StartClinicForm />);
    await screen.findByRole("heading", { name: "What kind of business?" });
    await user.click(screen.getByRole("radio", { name: /^Fitness/ }));
    expect(await screen.findByRole("heading", { name: "Name your studio" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "I take sessions myself" })).toBeChecked();
  });

  it("sends the owner back to confirm the email if the check ran out, keeping what they typed", async () => {
    server({
      proof: { email: "asha@example.com", method: "google", name: "Asha Rao" },
      register: { status: 422, body: { error: { code: "email_not_verified", message: "Confirm your email first." } } },
    });
    const user = userEvent.setup();
    render(<StartClinicForm providers={{ google: true, microsoft: false }} />);
    await screen.findByRole("heading", { name: "What kind of business?" });
    await nameBusiness(user, /^Salon/, "Style Studio");
    await user.click(screen.getByRole("button", { name: "Create salon" }));
    expect(await screen.findByRole("heading", { name: "Create your account" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your email check timed out");
    expect(screen.getByLabelText("Work email")).toHaveValue("asha@example.com");
  });

  it("keeps a taken booking link on the name screen with the field open", async () => {
    server({
      proof: { email: "asha@example.com", method: "google" },
      register: { status: 409, body: { error: { message: "Choose a different booking address.", fieldErrors: { slug: ["Already in use."] } } } },
    });
    const user = userEvent.setup();
    render(<StartClinicForm />);
    await screen.findByRole("heading", { name: "What kind of business?" });
    await nameBusiness(user, /^Dental/, "Lotus Dental", "Meera Iyer");
    await user.click(screen.getByRole("button", { name: "Create clinic" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a different booking address.");
    expect(screen.getByLabelText("Booking link")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/name$/, { selector: "#clinic-name" })).toHaveValue("Lotus Dental");
  });

  it("does not create the business twice if sign-in fails after it was made", async () => {
    const api = server();
    mocks.signInEmail.mockRejectedValue(new TypeError("Network unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<StartClinicForm />);
    await confirmEmail(user);
    await choosePassword(user);
    await nameBusiness(user, /^Dental/, "Lotus Dental", "Meera Iyer");
    await user.click(screen.getByRole("button", { name: "Create clinic" }));
    expect(await screen.findByRole("heading", { name: "Your clinic is ready." })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Sign in" }).map((link) => link.getAttribute("href"))).toContain("/sign-in?next=%2Fdashboard");
    expect(screen.queryByRole("button", { name: "Create clinic" })).not.toBeInTheDocument();
    expect(api.calls.filter((call) => call.url === "/api/public/clinics")).toHaveLength(1);
  });

  it("lets visitors rehearse without an account or any request", async () => {
    const api = server();
    const user = userEvent.setup();
    render(<StartClinicForm preview />);
    expect(screen.getByRole("heading", { name: "What kind of business?" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Work email")).not.toBeInTheDocument();
    await nameBusiness(user, /^Dental/, "Lotus Dental", "Meera Iyer");
    await user.click(screen.getByRole("button", { name: "Finish preview" }));
    expect(screen.getByRole("link", { name: /^Try .+ and availability setup$/ })).toHaveAttribute("href", "/setup");
    expect(api.request).not.toHaveBeenCalled();
  });

  it("offers every kind of business, moves on when a tile is tapped but not when chosen by keyboard", async () => {
    server();
    const user = userEvent.setup();
    render(<StartClinicForm preview />);
    for (const name of [/^General practice/, /^Dental/, /^Physiotherapy/, /^Salon/, /^Spa/, /^Barber/, /^Tutoring/, /^Consulting/, /^Fitness/, /^Something else/]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }
    screen.getByRole("radio", { name: /^Dental/ }).focus();
    await user.keyboard(" ");
    expect(screen.getByRole("radio", { name: /^Dental/ })).toBeChecked();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.queryByLabelText(/name$/, { selector: "#clinic-name" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /^Salon/ }));
    // The first field takes focus, so the owner can type the name straight away.
    expect(await screen.findByLabelText(/name$/, { selector: "#clinic-name" }, { timeout: 1000 })).toHaveFocus();
  });
});
