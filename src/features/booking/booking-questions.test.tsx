/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkFormAnswers, type FormField, type PublicFormDefinition } from "@/lib/booking-forms";
import type { IntakeSettings } from "@/lib/booking-intake";
import { publicBookingSchema } from "@/lib/contracts";
import { demoClinic, demoLocations, demoPractitioners, demoResources, demoServices, demoSlots } from "@/lib/demo-data";

import { BookingFlow } from "./booking-flow";
import { render } from "./test-support";

vi.mock("./visitor-zone", () => ({ detectVisitorZone: () => "Asia/Kolkata", detectVisitorLocale: () => "en-IN" }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type User = ReturnType<typeof userEvent.setup>;
type Json = Record<string, unknown>;

const response = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const intake = (patch: Partial<IntakeSettings> = {}): IntakeSettings => ({ contactMode: "email_or_phone", allowGuests: false, maxGuests: 3, verifyEmail: false, ...patch });

function formWith(fields: FormField[], extra: Partial<PublicFormDefinition> = {}): PublicFormDefinition {
  return {
    id: "form_questions_v1",
    key: "form_questions",
    version: 1,
    name: "Before your visit",
    description: "",
    appliesToAll: false,
    serviceIds: ["service_cleaning"],
    fields,
    ...extra,
  };
}

interface Server {
  fetch: ReturnType<typeof vi.fn>;
  /** The body of the booking request, parsed. */
  booking: () => Json;
  checks: () => Json[];
}

/** Answers every call the flow makes. `emailCheck` decides what the code endpoint says. */
function stubServer(options: { emailCheck?: (body: Json) => Response; booking?: () => Response } = {}): Server {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/public/availability?")) return response({ data: { slots: [demoSlots[0]] } });
    if (url === "/api/public/holds") return response({ data: { holdToken: "hold-token-number-1-xxxxxxxxxxxx", expiresAt: new Date(Date.now() + 300_000).toISOString() } }, 201);
    if (url === "/api/public/email-check") return (options.emailCheck ?? (() => response({ data: { sent: true, expiresInMinutes: 10 } })))(JSON.parse(String(init?.body)));
    if (url === "/api/public/appointments" && init?.method === "POST") {
      return options.booking?.() ?? response({ data: { appointmentId: "appointment_created", manageToken: "manage-created", status: "booked", startsAt: demoSlots[0].startsAt, endsAt: demoSlots[0].endsAt } }, 201);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetch: fetchMock,
    booking: () => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/public/appointments" && (init as RequestInit | undefined)?.method === "POST");
      expect(call).toBeDefined();
      return JSON.parse(String((call?.[1] as RequestInit).body)) as Json;
    },
    checks: () => fetchMock.mock.calls.filter(([input]) => String(input) === "/api/public/email-check").map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Json),
  };
}

function renderFlow(options: { forms?: PublicFormDefinition[]; intake?: IntakeSettings; prefill?: Record<string, string>; preview?: boolean } = {}) {
  const services = demoServices.map((service) => (service.id === "service_cleaning" && options.intake ? { ...service, intake: options.intake } : service));
  render(
    <BookingFlow
      clinic={demoClinic}
      locations={demoLocations}
      services={services}
      practitioners={demoPractitioners}
      resources={demoResources}
      initialSlots={demoSlots}
      allowDemoFallback={options.preview ?? false}
      forms={options.forms}
      prefill={options.prefill}
    />,
  );
}

/** Picking moves on by itself; the screen has moved on once the choice is gone. */
async function pickAndContinue(user: User, choice: HTMLElement) {
  await user.click(choice);
  await waitFor(() => expect(choice).not.toBeInTheDocument());
}

async function chooseUpToTime(user: User) {
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Indiranagar/i }));
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Routine cleaning/i }));
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Anyone available/i }));
  await pickAndContinue(user, await screen.findByRole("radio", { name: /9:30/i }));
}

async function fillDetails(user: User, contact: { phone?: string; email?: string } = { phone: "+91 98450 12345", email: "ananya@example.com" }) {
  await screen.findByRole("heading", { name: "Last step: your details" });
  await user.type(screen.getByRole("textbox", { name: "Full name" }), "Ananya Rao");
  if (contact.phone) await user.type(screen.getByRole("textbox", { name: "Mobile number" }), contact.phone);
  if (contact.email) await user.type(screen.getByRole("textbox", { name: "Email address" }), contact.email);
  await user.click(screen.getByRole("checkbox", { name: /I understand and agree to this use of the booking details/i }));
}

const book = (user: User) => user.click(screen.getByRole("button", { name: "Confirm booking" }));

describe("questions that show and hide", () => {
  const fields: FormField[] = [
    { id: "visited", type: "radio", label: "Have you visited before?", required: true, options: ["Yes", "No"] },
    { id: "heard", type: "short_text", label: "How did you hear about us?", required: true, showWhen: [{ fieldId: "visited", operator: "equals", value: "No" }] },
  ];

  it("reveals a question on No, hides it on Yes and never sends the hidden answer", async () => {
    const user = userEvent.setup();
    const server = stubServer();
    renderFlow({ forms: [formWith(fields)] });
    await chooseUpToTime(user);

    await screen.findByRole("heading", { name: "Before your visit" });
    expect(screen.queryByRole("textbox", { name: /How did you hear/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "No" }));
    await user.type(await screen.findByRole("textbox", { name: /How did you hear/ }), "A friend told me");

    await user.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /How did you hear/ })).not.toBeInTheDocument());

    // Back to No: the old answer was dropped with the question.
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(await screen.findByRole("textbox", { name: /How did you hear/ })).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Yes" }));

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await fillDetails(user);
    await book(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    expect(server.booking().formAnswers).toEqual({ visited: "Yes" });
  });

  it("does not ask a hidden question's answer of the customer and skips a screen with nothing to ask", async () => {
    const user = userEvent.setup();
    stubServer();
    renderFlow({ forms: [formWith([{ id: "campaign", type: "short_text", label: "Campaign", required: false, hidden: true, prefillKey: "campaign" }])] });
    await chooseUpToTime(user);
    expect(await screen.findByRole("heading", { name: "Last step: your details" })).toBeInTheDocument();
    expect(screen.queryByText("Campaign")).not.toBeInTheDocument();
  });
});

describe("filling from the booking link", () => {
  const fields: FormField[] = [
    { id: "campaign", type: "short_text", label: "Campaign", required: false, hidden: true, prefillKey: "campaign" },
    { id: "source", type: "short_text", label: "Where from?", required: true, prefillKey: "source", lockWhenPrefilled: true },
    { id: "note", type: "short_text", label: "Anything else?", required: false, prefillKey: "note" },
  ];

  it("locks the email, stores the hidden campaign and starts the other questions with the link's value", async () => {
    const user = userEvent.setup();
    const server = stubServer();
    renderFlow({
      forms: [formWith(fields)],
      prefill: { email: "link@example.com", campaign: "diwali", source: "newsletter", note: "Hello", name: "Meera Iyer", phone: "bad" },
    });
    await chooseUpToTime(user);

    const source = await screen.findByRole("textbox", { name: /Where from/ });
    expect(source).toHaveValue("newsletter");
    expect(source).toHaveAttribute("readonly");
    expect(screen.getByRole("textbox", { name: /Anything else/ })).toHaveValue("Hello");
    expect(screen.queryByText("Campaign")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByRole("heading", { name: "Last step: your details" });
    const email = screen.getByRole("textbox", { name: "Email address" });
    expect(email).toHaveValue("link@example.com");
    expect(email).toHaveAttribute("readonly");
    expect(screen.getByText("Filled from your link")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Full name" })).toHaveValue("Meera Iyer");
    // A phone number that is not valid was ignored without a word.
    expect(screen.getByRole("textbox", { name: "Mobile number" })).toHaveValue("");
    await user.click(screen.getByRole("checkbox", { name: /I understand and agree/i }));
    await book(user);
    await screen.findByRole("heading", { name: /You.re booked/ });

    const body = server.booking();
    expect(body.email).toBe("link@example.com");
    expect(body.phone).toBe("");
    expect(body.formAnswers).toEqual({ campaign: "diwali", source: "newsletter", note: "Hello" });
    expect(publicBookingSchema.safeParse(body).success).toBe(true);
  });

  it("ignores values that do not fit the question or the details", async () => {
    const user = userEvent.setup();
    const server = stubServer();
    renderFlow({ forms: [formWith(fields)], prefill: { email: "not-an-email", campaign: "", name: "M", location: "nowhere" } });
    await chooseUpToTime(user);
    await user.type(await screen.findByRole("textbox", { name: /Where from/ }), "Friend");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("textbox", { name: "Email address" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Full name" })).toHaveValue("");
    await fillDetails(user);
    await book(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    expect(server.booking().formAnswers).toEqual({ source: "Friend" });
  });
});

describe("the new question types", () => {
  const fields: FormField[] = [
    { id: "tier", type: "radio", label: "Which plan?", required: true, options: ["Basic", "Plus"] },
    { id: "topics", type: "checkbox_group", label: "Topics", required: false, options: ["Teeth", "Gums", "Braces"] },
    { id: "areas", type: "multi_select", label: "Areas", required: false, options: ["Koramangala", "Indiranagar", "Whitefield"] },
    { id: "site", type: "url", label: "Your website", required: false },
    { id: "home", type: "address", label: "Home address", required: false },
    { id: "extra", type: "emails", label: "Who else should we tell?", required: false },
    { id: "who", type: "name_split", label: "Patient name", required: false },
  ];

  it("sends each answer in the shape the server checks", async () => {
    const user = userEvent.setup();
    const server = stubServer();
    renderFlow({ forms: [formWith(fields)] });
    await chooseUpToTime(user);
    await screen.findByRole("heading", { name: "Before your visit" });

    await user.click(screen.getByRole("button", { name: "Plus" }));
    await user.click(screen.getByRole("button", { name: "Braces" }));
    await user.click(screen.getByRole("button", { name: "Teeth" }));
    await user.type(screen.getByRole("textbox", { name: "Your website" }), "https://example.com");
    await user.type(screen.getByRole("textbox", { name: "Address line 1" }), "12 MG Road");
    await user.type(screen.getByRole("textbox", { name: "City" }), "Bengaluru");
    await user.type(screen.getByRole("textbox", { name: "State" }), "Karnataka");
    await user.type(screen.getByRole("textbox", { name: "PIN code" }), "560001");
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "friend@example.com");
    await user.click(screen.getByRole("button", { name: "Add another email address" }));
    await user.type(screen.getByRole("textbox", { name: "Email address 2" }), "second@example.com");
    const patient = within(screen.getByRole("group", { name: "Patient name" }));
    await user.type(patient.getByRole("textbox", { name: "First name" }), "Meera");
    await user.type(patient.getByRole("textbox", { name: "Last name" }), "Iyer");

    const search = screen.getByRole("combobox", { name: "Areas" });
    await user.click(search);
    await user.click(await screen.findByRole("option", { name: "Whitefield" }));
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await fillDetails(user);
    await book(user);
    await screen.findByRole("heading", { name: /You.re booked/ });

    const answers = server.booking().formAnswers;
    expect(answers).toEqual({
      tier: "Plus",
      // The business's order, whatever order the boxes were ticked in.
      topics: ["Teeth", "Braces"],
      areas: ["Whitefield"],
      site: "https://example.com",
      home: { line1: "12 MG Road", city: "Bengaluru", state: "Karnataka", pin: "560001" },
      extra: ["friend@example.com", "second@example.com"],
      who: { first: "Meera", last: "Iyer" },
    });
    expect(checkFormAnswers(fields, answers as never).ok).toBe(true);
  });

  it("explains a half-filled address and a bad web address", async () => {
    const user = userEvent.setup();
    stubServer();
    renderFlow({ forms: [formWith(fields)] });
    await chooseUpToTime(user);
    await user.click(await screen.findByRole("button", { name: "Basic" }));
    await user.type(screen.getByRole("textbox", { name: "Your website" }), "not a web address");
    await user.type(screen.getByRole("textbox", { name: "Address line 1" }), "12 MG Road");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("link", { name: "Home address — Fill in the street, city and state." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Your website — Enter a web address/ })).toBeInTheDocument();
  });

  it("shows a guest-email question as a list when the service takes no guests, and leaves it to Add guests when it does", async () => {
    const user = userEvent.setup();
    stubServer();
    renderFlow({ forms: [formWith([fields[5], fields[0]])], intake: intake({ allowGuests: true, maxGuests: 2 }) });
    await chooseUpToTime(user);
    await screen.findByRole("heading", { name: "Before your visit" });
    expect(screen.queryByText("Who else should we tell?")).not.toBeInTheDocument();
  });
});

describe("required for one service", () => {
  const optionalField: FormField = { id: "note", type: "short_text", label: "A note", required: false };

  it("asks for an answer when this service's override makes it required", async () => {
    const user = userEvent.setup();
    const server = stubServer();
    renderFlow({ forms: [formWith([optionalField], { requiredOverrides: { service_cleaning: { note: true } } })] });
    await chooseUpToTime(user);
    const note = await screen.findByRole("textbox", { name: /A note/ });
    expect(screen.queryByText("Optional")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("link", { name: "A note — Answer this question." })).toBeInTheDocument();
    await user.type(note, "Fine");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await fillDetails(user);
    await book(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    expect(server.booking().formAnswers).toEqual({ note: "Fine" });
  });

  it("lets a question the form requires go unanswered when the override makes it optional", async () => {
    const user = userEvent.setup();
    stubServer();
    renderFlow({ forms: [formWith([{ ...optionalField, required: true }], { requiredOverrides: { service_cleaning: { note: false } } })] });
    await chooseUpToTime(user);
    // Optional free text starts as a No / Yes tap, with no box until Yes.
    await screen.findByRole("button", { name: "Yes" });
    expect(screen.queryByRole("textbox", { name: /A note/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Last step: your details" })).toBeInTheDocument();
  });
});

describe("contact details by service", () => {
  it("asks phone-only services for a number and no email, and books with an empty email", async () => {
    const user = userEvent.setup();
    const server = stubServer();
    renderFlow({ intake: intake({ contactMode: "phone_only" }) });
    await chooseUpToTime(user);
    await screen.findByRole("heading", { name: "Last step: your details" });

    expect(screen.queryByRole("textbox", { name: "Email address" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Full name" }), "Ananya Rao");
    await user.click(screen.getByRole("checkbox", { name: /I understand and agree/i }));
    await book(user);
    expect(await screen.findByRole("link", { name: "Enter your phone number." })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Mobile number" }), "+91 98450 12345");
    await book(user);
    expect(await screen.findByRole("link", { name: "Tick this so we can reach you without an email." })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Send confirmations and reminders by text message or WhatsApp/ }));

    // The reminder choices leave email out.
    await user.click(screen.getByRole("button", { name: "Add more details (optional)" }));
    await user.click(screen.getByRole("combobox", { name: /How should .* contact you/ }));
    expect(await screen.findByRole("option", { name: "WhatsApp" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Email" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await book(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    const body = server.booking();
    expect(body.email).toBe("");
    expect(body.phone).toBe("+919845012345");
    expect(body.messagingConsent).toBe(true);
    expect(["sms", "whatsapp", "phone"]).toContain(body.preferredChannel);
    expect(publicBookingSchema.safeParse(body).success).toBe(true);
  });

  it("accepts either an email or a phone number when the service takes either", async () => {
    const user = userEvent.setup();
    const server = stubServer();
    renderFlow();
    await chooseUpToTime(user);
    await fillDetails(user, { email: "only-email@example.com" });
    expect(screen.getByText("Email or phone — at least one")).toBeInTheDocument();
    await book(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    const body = server.booking();
    expect(body.phone).toBe("");
    // With no number to text, reminders go by email.
    expect(body.preferredChannel).toBe("email");
    expect(publicBookingSchema.safeParse(body).success).toBe(true);
  });

  it("requires an email when the service does", async () => {
    const user = userEvent.setup();
    stubServer();
    renderFlow({ intake: intake({ contactMode: "email_required" }) });
    await chooseUpToTime(user);
    await fillDetails(user, { phone: "+91 98450 12345" });
    await book(user);
    expect(await screen.findByRole("link", { name: "Enter your email address." })).toBeInTheDocument();
  });
});

describe("guests", () => {
  it("collects guest emails, shows them in the summary and sends them", async () => {
    const user = userEvent.setup();
    const server = stubServer();
    renderFlow({ intake: intake({ allowGuests: true, maxGuests: 2 }) });
    await chooseUpToTime(user);
    await fillDetails(user);

    await user.click(screen.getByRole("button", { name: /Add guests/ }));
    expect(screen.getByText(/Up to 2 guests/)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Guest email" }), "partner@example.com");
    await user.click(screen.getByRole("button", { name: "Add another guest" }));
    await user.type(screen.getByRole("textbox", { name: "Guest email 2" }), "bad-address");
    expect(screen.queryByRole("button", { name: "Add another guest" })).not.toBeInTheDocument();

    await book(user);
    expect(await screen.findByRole("link", { name: "Enter guest email addresses like name@example.com." })).toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "Guest email 2" }));
    await user.type(screen.getByRole("textbox", { name: "Guest email 2" }), "friend@example.com");
    expect(screen.getAllByText("2 guests").length).toBeGreaterThan(0);
    await book(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    expect(server.booking().guests).toEqual(["partner@example.com", "friend@example.com"]);
  });

  it("takes guests from the link only when the service allows them", async () => {
    const user = userEvent.setup();
    const server = stubServer();
    renderFlow({ intake: intake({ allowGuests: true, maxGuests: 2 }), prefill: { guests: "a@example.com, b@example.com, c@example.com, nonsense" } });
    await chooseUpToTime(user);
    await fillDetails(user);
    expect(screen.getByRole("textbox", { name: "Guest email 1" })).toHaveValue("a@example.com");
    await book(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    expect(server.booking().guests).toEqual(["a@example.com", "b@example.com"]);
  });

  it("has no guests row on a service without them", async () => {
    const user = userEvent.setup();
    const server = stubServer();
    renderFlow({ prefill: { guests: "a@example.com" } });
    await chooseUpToTime(user);
    await fillDetails(user);
    expect(screen.queryByRole("button", { name: /Add guests/ })).not.toBeInTheDocument();
    await book(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    expect(server.booking()).not.toHaveProperty("guests");
  });
});

describe("the email check", () => {
  async function typeCode(user: User, code: string) {
    await user.click(screen.getAllByRole("textbox", { name: "6-digit code" })[0]);
    await user.keyboard(code);
  }

  const checking = () => intake({ verifyEmail: true });

  it("blocks booking until the code is confirmed, then sends the proof", async () => {
    const user = userEvent.setup();
    let wrong = 0;
    const server = stubServer({
      emailCheck: (body) => {
        if (body.action === "send") return response({ data: { sent: true, expiresInMinutes: 10 } });
        if (body.code === "111111") {
          wrong += 1;
          return response({ error: { code: "invalid_code", message: "That code isn't right or has expired." } }, 400);
        }
        return response({ data: { proof: "proof-token-for-this-booking-0001" } });
      },
    });
    renderFlow({ intake: checking() });
    await chooseUpToTime(user);
    await fillDetails(user);

    expect(screen.getByRole("heading", { name: "Email check" })).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm booking" });
    expect(confirm).toBeDisabled();
    expect(screen.getByText("Confirm your email with the code we send you, then you can book.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    expect(await screen.findByText(/We sent a 6-digit code to ananya@example.com/)).toBeInTheDocument();
    expect(server.checks()[0]).toEqual({ action: "send", clinicSlug: demoClinic.slug, serviceId: "service_cleaning", email: "ananya@example.com" });

    await typeCode(user, "111111");
    expect(await screen.findByText("That code is not right. Check the email and try again.")).toBeInTheDocument();
    expect(wrong).toBe(1);
    expect(screen.getByRole("button", { name: "Confirm booking" })).toBeDisabled();

    await typeCode(user, "424242");
    expect(await screen.findByText("Email confirmed")).toBeInTheDocument();
    expect(server.checks()[2]).toEqual({ action: "verify", clinicSlug: demoClinic.slug, email: "ananya@example.com", code: "424242" });
    expect(screen.getByRole("button", { name: "Confirm booking" })).toBeEnabled();

    await book(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    const body = server.booking();
    expect(body.emailProof).toBe("proof-token-for-this-booking-0001");
    expect(publicBookingSchema.safeParse(body).success).toBe(true);
  });

  it("starts over when the email changes", async () => {
    const user = userEvent.setup();
    stubServer({ emailCheck: (body) => (body.action === "send" ? response({ data: { sent: true, expiresInMinutes: 10 } }) : response({ data: { proof: "proof-token-for-this-booking-0002" } })) });
    renderFlow({ intake: checking() });
    await chooseUpToTime(user);
    await fillDetails(user);
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    await typeCode(user, "424242");
    await screen.findByText("Email confirmed");

    await user.type(screen.getByRole("textbox", { name: "Email address" }), "x");
    expect(screen.queryByText("Email confirmed")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Send me a code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm booking" })).toBeDisabled();
  });

  it("says when the customer has used up their wrong codes", async () => {
    const user = userEvent.setup();
    stubServer({
      emailCheck: (body) => (body.action === "send"
        ? response({ data: { sent: true, expiresInMinutes: 10 } })
        : response({ error: { code: "too_many_attempts", message: "Too many wrong codes. Ask for a new code and try again." } }, 429)),
    });
    renderFlow({ intake: checking() });
    await chooseUpToTime(user);
    await fillDetails(user);
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    await typeCode(user, "123456");
    expect(await screen.findByText("Too many wrong codes. Ask for a new code.")).toBeInTheDocument();
    // A new code can be asked for at once.
    expect(screen.getByRole("button", { name: "Send a new code" })).toBeEnabled();
  });

  it("makes the customer wait 30 seconds before another code", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = stubServer();
    renderFlow({ intake: checking() });
    await chooseUpToTime(user);
    await fillDetails(user);
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    const resend = await screen.findByRole("button", { name: "Send a new code" });
    expect(resend).toBeDisabled();
    expect(screen.getByText(/You can ask again in \d+ s/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(screen.getByRole("button", { name: "Send a new code" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Send a new code" }));
    await waitFor(() => expect(server.checks().filter((body) => body.action === "send")).toHaveLength(2));
  });

  it("shows a clear message when too many codes were asked for", async () => {
    const user = userEvent.setup();
    stubServer({ emailCheck: () => response({ error: { code: "too_many_codes", message: "x" } }, 429) });
    renderFlow({ intake: checking() });
    await chooseUpToTime(user);
    await fillDetails(user);
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    expect(await screen.findByText("Too many codes were sent to this address. Wait an hour, then ask for a new one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send me a code" })).toBeEnabled();
  });

  it("does not ask for the check when the server says it is not needed", async () => {
    const user = userEvent.setup();
    stubServer({ emailCheck: () => response({ error: { code: "email_check_not_required", message: "No code needed." } }, 409) });
    renderFlow({ intake: checking() });
    await chooseUpToTime(user);
    await fillDetails(user);
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Email check" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Confirm booking" })).toBeEnabled();
  });

  it("resets the block when the booking says the proof no longer counts", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    stubServer({
      emailCheck: (body) => (body.action === "send" ? response({ data: { sent: true, expiresInMinutes: 10 } }) : response({ data: { proof: `proof-token-number-${(attempts += 1)}-xxxxxxxxxx` } })),
      booking: () => response({ error: { code: "email_not_verified", message: "Please confirm your email address with the code we sent.", fieldErrors: { email: ["Confirm your email address with the code we sent."] } } }, 422),
    });
    renderFlow({ intake: checking() });
    await chooseUpToTime(user);
    await fillDetails(user);
    await user.click(screen.getByRole("button", { name: "Send me a code" }));
    await typeCode(user, "424242");
    await screen.findByText("Email confirmed");
    await book(user);

    expect(await screen.findByText("Your email check no longer counts. Ask for a new code.")).toBeInTheDocument();
    expect(screen.queryByText("Email confirmed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send me a code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm booking" })).toBeDisabled();
  });

  it("does not ask for a code in the preview", async () => {
    const user = userEvent.setup();
    stubServer();
    renderFlow({ intake: checking(), preview: true });
    await chooseUpToTime(user);
    await fillDetails(user);
    expect(screen.queryByRole("heading", { name: "Email check" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm booking" })).toBeEnabled();
  });

  it("does not ask for a code when no email was given", async () => {
    const user = userEvent.setup();
    stubServer();
    renderFlow({ intake: checking() });
    await chooseUpToTime(user);
    await fillDetails(user, { phone: "+91 98450 12345" });
    expect(screen.queryByRole("heading", { name: "Email check" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm booking" })).toBeEnabled();
  });
});

describe("tap-first question chips", () => {
  const optionalField: FormField = { id: "note", type: "short_text", label: "A note", required: false };

  it("keeps Yes and the typed text when Yes is tapped again", async () => {
    const user = userEvent.setup();
    stubServer();
    renderFlow({ forms: [formWith([optionalField])] });
    await chooseUpToTime(user);
    await user.click(await screen.findByRole("button", { name: "Yes" }));
    await user.type(await screen.findByRole("textbox", { name: /A note/ }), "Side door");
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(screen.getByRole("textbox", { name: /A note/ })).toHaveValue("Side door");
  });

  it("clears the text on No and remembers No after Back", async () => {
    const user = userEvent.setup();
    stubServer();
    renderFlow({ forms: [formWith([optionalField])] });
    await chooseUpToTime(user);
    await user.click(await screen.findByRole("button", { name: "Yes" }));
    await user.type(await screen.findByRole("textbox", { name: /A note/ }), "Side door");
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(screen.queryByRole("textbox", { name: /A note/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Last step: your details" });
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { kalendrBookingStep: "questions" } }));
    });
    await user.click(screen.getByRole("button", { name: "Back" }));
    back.mockRestore();

    expect(await screen.findByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a required single choice when it is tapped again", async () => {
    const user = userEvent.setup();
    stubServer();
    renderFlow({ forms: [formWith([{ id: "visited", type: "radio", label: "Have you visited before?", required: true, options: ["Yes", "No"] }])] });
    await chooseUpToTime(user);
    await user.click(await screen.findByRole("button", { name: "No" }));
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(screen.getByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "true");
  });

  it("lets an optional single choice be cleared by tapping it again", async () => {
    const user = userEvent.setup();
    stubServer();
    renderFlow({ forms: [formWith([{ id: "visited", type: "radio", label: "Have you visited before?", required: false, options: ["Yes", "No"] }])] });
    await chooseUpToTime(user);
    await user.click(await screen.findByRole("button", { name: "No" }));
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(screen.getByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "false");
  });
});
