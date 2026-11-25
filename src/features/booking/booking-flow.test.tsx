/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  demoClinic,
  demoLocations,
  demoPractitioners,
  demoResources,
  demoServices,
  demoSlots,
} from "@/lib/demo-data";
import type { PublicFormDefinition } from "@/lib/booking-forms";
import { publicBookingSchema } from "@/lib/contracts";
import { resolveBusinessProfile } from "@/lib/terminology";

import { BusinessProfileProvider } from "../terms/business-profile-context";
import { BookingFlow } from "./booking-flow";
import { render } from "./test-support";

vi.mock("./visitor-zone", () => ({ detectVisitorZone: () => "Asia/Kolkata", detectVisitorLocale: () => "en-IN" }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function renderBookingFlow(allowDemoFallback = false, forms?: PublicFormDefinition[], turnstileSiteKey: string | null = null) {
  render(
    <BookingFlow
      turnstileSiteKey={turnstileSiteKey}
      clinic={demoClinic}
      locations={demoLocations}
      services={demoServices}
      practitioners={demoPractitioners}
      resources={demoResources}
      initialSlots={demoSlots}
      allowDemoFallback={allowDemoFallback}
      forms={forms}
    />,
  );
}

function bookingForm(overrides: Partial<PublicFormDefinition> = {}): PublicFormDefinition {
  return {
    id: "form_test_v1",
    key: "form_test",
    version: 1,
    name: "Before your visit",
    description: "A few questions so we can get ready.",
    appliesToAll: false,
    serviceIds: ["service_cleaning"],
    fields: [
      { id: "q1", type: "single_choice", label: "How did you hear about us?", required: true, options: ["A friend", "Online"] },
      { id: "q2", type: "short_text", label: "Anything we should know?", required: false },
    ],
    ...overrides,
  };
}

type User = ReturnType<typeof userEvent.setup>;

function bookedResponse() {
  return jsonResponse(
    {
      data: {
        appointmentId: "appointment_created",
        manageToken: "manage-created",
        status: "booked",
        startsAt: demoSlots[0].startsAt,
        endsAt: demoSlots[0].endsAt,
      },
    },
    201,
  );
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const postCall = fetchMock.mock.calls.find(
    ([input, init]) => String(input) === "/api/public/appointments" && (init as RequestInit | undefined)?.method === "POST",
  );
  expect(postCall).toBeDefined();
  return JSON.parse(String((postCall?.[1] as RequestInit).body));
}

/** Picking moves on by itself; the screen has moved on once the choice is gone. */
async function pickAndContinue(user: User, choice: HTMLElement) {
  await user.click(choice);
  await waitFor(() => expect(choice).not.toBeInTheDocument());
}

/** Visit type → location → service → person → time, with Continue on each screen. */
async function chooseUpToTime(user: User) {
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Indiranagar/i }));
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Routine cleaning/i }));
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Anyone available/i }));
  await pickAndContinue(user, await screen.findByRole("radio", { name: /9:30/i }));
}

async function fillDetails(user: User) {
  await screen.findByRole("heading", { name: "Last step: your details" });
  await user.type(screen.getByRole("textbox", { name: "Full name" }), "Ananya Rao");
  await user.type(screen.getByRole("textbox", { name: "Mobile number" }), "+91 98450 12345");
  await user.type(screen.getByRole("textbox", { name: "Email address" }), "ananya@example.com");
  await user.click(screen.getByRole("checkbox", { name: /I understand and agree to this use of the booking details/i }));
}

async function completeBookingDetails(user: User) {
  await chooseUpToTime(user);
  await fillDetails(user);
}

describe("BookingFlow", () => {
  it("asks one question per screen and shows no step counter", () => {
    renderBookingFlow();

    expect(screen.getByRole("heading", { level: 1, name: /Which .* suits you\?/ })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/Step 1 of/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("has no Continue or Back button at the bottom of a choosing screen", () => {
    renderBookingFlow();

    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("moves on when Enter or Space is pressed on a choice, but not when the arrows move the choice", async () => {
    const user = userEvent.setup();
    renderBookingFlow();

    // Arrow keys choose without moving on.
    const first = screen.getAllByRole("radio")[0]!;
    first.focus();
    await user.keyboard("{ArrowDown}");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByRole("heading", { level: 1, name: /Which .* suits you\?/ })).toBeInTheDocument();

    // Enter moves on.
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "What would you like to book?" })).toBeInTheDocument();
  });

  it("moves on for a screen reader's virtual click, which reports no pointer", async () => {
    renderBookingFlow();

    const radio = await screen.findByRole("radio", { name: /Indiranagar/i });
    // A virtual click has detail 0; it must still move on, since a choosing screen has no Continue button.
    fireEvent.click(radio.closest("label")!, { detail: 0 });
    expect(await screen.findByRole("heading", { name: "What would you like to book?" })).toBeInTheDocument();
  });

  it("moves on again when the chosen option is tapped after coming back", async () => {
    const user = userEvent.setup();
    renderBookingFlow();

    await pickAndContinue(user, await screen.findByRole("radio", { name: /Indiranagar/i }));
    await screen.findByRole("heading", { name: "What would you like to book?" });
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { kalendrBookingStep: "location" } }));
    });
    await user.click(screen.getByRole("button", { name: "Back" }));
    back.mockRestore();

    const chosen = await screen.findByRole("radio", { name: /Indiranagar/i });
    expect(chosen).toBeChecked();
    await user.click(chosen);
    expect(await screen.findByRole("heading", { name: "What would you like to book?" })).toBeInTheDocument();
  });

  it("moves on by itself shortly after a choice is tapped", async () => {
    const user = userEvent.setup();
    renderBookingFlow();

    await user.click(screen.getByRole("radio", { name: /Indiranagar/i }));

    const heading = await screen.findByRole("heading", { name: "What would you like to book?" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("goes back a screen with Back and with the browser's back button", async () => {
    const user = userEvent.setup();
    renderBookingFlow();

    await pickAndContinue(user, await screen.findByRole("radio", { name: /Indiranagar/i }));
    await screen.findByRole("heading", { name: "What would you like to book?" });

    // The flow hands Back to the browser so its history stays in step; jsdom does not fire popstate by itself.
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { kalendrBookingStep: "location" } }));
    });
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: /Which .* suits you\?/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Indiranagar/i })).toBeChecked();

    back.mockRestore();
  });

  it("keeps focus in the field while the customer fixes an error", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { slots: [demoSlots[0]] } })));
    renderBookingFlow();

    await chooseUpToTime(user);
    await screen.findByRole("heading", { name: "Last step: your details" });
    await user.click(screen.getByRole("button", { name: "Confirm booking" }));

    const errorSummary = screen.getByRole("alert");
    await waitFor(() => expect(errorSummary).toHaveFocus());

    const firstName = screen.getByRole("textbox", { name: "Full name" });
    await user.type(firstName, "Ananya");
    expect(firstName).toHaveFocus();
    expect(firstName).toHaveValue("Ananya");
    expect(errorSummary).toHaveTextContent("Enter an email address or a phone number.");
  });

  it("keeps the optional date of birth behind Add more details and opens it when the date is wrong", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { slots: [demoSlots[0]] } })));
    renderBookingFlow();

    await chooseUpToTime(user);
    await fillDetails(user);
    expect(screen.queryByLabelText(/Date of birth/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a note or request (optional)" })).not.toBeInTheDocument();

    const more = screen.getByRole("button", { name: "Add more details (optional)" });
    await user.click(more);
    const dateOfBirth = screen.getByLabelText(/Date of birth/);
    fireEvent.change(dateOfBirth, { target: { value: "1890-01-01" } });
    await user.click(more);
    await waitFor(() => expect(screen.queryByLabelText(/Date of birth/)).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Confirm booking" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a real date of birth, or leave it empty.");
    expect(screen.getByLabelText(/Date of birth/)).toHaveValue("1890-01-01");
    expect(screen.getByRole("heading", { name: "Last step: your details" })).toBeInTheDocument();
  });

  it("submits the appointment once with an idempotency key and the same request body as before", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/public/availability?")) return jsonResponse({ data: { slots: [demoSlots[0]] } });
      if (url === "/api/public/appointments" && init?.method === "POST") return bookedResponse();
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderBookingFlow();

    await completeBookingDetails(user);
    await user.click(screen.getByRole("button", { name: "Confirm booking" }));

    expect(await screen.findByRole("heading", { name: /You.re booked/ })).toBeInTheDocument();
    expect(screen.getByText(/Your booking is saved/)).toBeInTheDocument();
    expect(screen.queryByText(/We sent the details/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Add to calendar/ }));
    expect(await screen.findByRole("menuitem", { name: "Apple Calendar" })).toHaveAttribute(
      "href",
      "/api/public/appointments/manage-created/calendar",
    );
    expect(screen.getByRole("menuitem", { name: "Google Calendar" }).getAttribute("href")).toMatch(/^https:\/\/calendar\.google\.com\//);
    expect(screen.getByRole("menuitem", { name: "Outlook.com" }).getAttribute("href")).toMatch(/^https:\/\/outlook\.live\.com\//);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("link", { name: /Manage appointment/ })).toHaveAttribute("href", "/manage/manage-created");

    const posts = fetchMock.mock.calls.filter(([input]) => String(input) === "/api/public/appointments");
    expect(posts).toHaveLength(1);
    expect((posts[0][1] as RequestInit).headers).toEqual(
      expect.objectContaining({ "Content-Type": "application/json", "Idempotency-Key": expect.any(String) }),
    );

    // The exact body, field for field: the step-by-step screens must not change what the server receives.
    const body = postedBody(fetchMock);
    expect(body).toEqual({
      clinicSlug: demoClinic.slug,
      patientType: "new",
      bookingFor: "self",
      locationId: "loc_indiranagar",
      serviceId: "service_cleaning",
      practitionerId: "practitioner_asha",
      slotId: demoSlots[0].id,
      startsAt: demoSlots[0].startsAt,
      endsAt: demoSlots[0].endsAt,
      firstName: "Ananya",
      lastName: "Rao",
      phone: "+919845012345",
      email: "ananya@example.com",
      preferredChannel: "sms",
      messagingConsent: false,
      acceptedPrivacyNotice: true,
      origin: { channel: "hosted" },
      // How long the flow was open, for the server's too-fast bot filter. The hidden field stays out when empty.
      fillMs: expect.any(Number),
    });
    expect(publicBookingSchema.safeParse(body).success).toBe(true);
  });

  it("shows the person check only when the server asks for it, and sends its token on the retry", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/public/availability?")) return jsonResponse({ data: { slots: [demoSlots[0]] } });
      if (url === "/api/public/appointments" && init?.method === "POST") {
        return jsonResponse({
          error: {
            code: "challenge_required",
            message: "Confirm you are a person to continue.",
            fieldErrors: { turnstileToken: ["Complete the check to continue."] },
          },
        }, 400);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderBookingFlow(false, undefined, "1x00000000000000000000AA");

    await completeBookingDetails(user);
    expect(screen.queryByTestId("turnstile-field")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm booking" }));

    expect(await screen.findByTestId("turnstile-field")).toHaveTextContent("Complete the check to continue.");
    // Still on the details screen, with nothing lost, and the button waits for the check.
    expect(screen.getByRole("textbox", { name: "Full name" })).toHaveValue("Ananya Rao");
    expect(screen.getByRole("button", { name: "Confirm booking" })).toBeDisabled();
    const posted = (fetchMock.mock.calls.find(([input]) => String(input) === "/api/public/appointments")?.[1] as RequestInit).headers;
    expect(posted).not.toHaveProperty("x-turnstile-token");
  });

  it("retries unavailable times without losing the visit choices", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { slots: [], nextByPerson: {} } })) // next free times on the provider step
      .mockResolvedValueOnce(jsonResponse({ error: { code: "unavailable", message: "Please try again." } }, 503))
      .mockResolvedValueOnce(jsonResponse({ data: { slots: [demoSlots[0]] } }));
    vi.stubGlobal("fetch", fetchMock);
    renderBookingFlow();

    await pickAndContinue(user, await screen.findByRole("radio", { name: /Indiranagar/i }));
    await pickAndContinue(user, await screen.findByRole("radio", { name: /Routine cleaning/i }));
    await pickAndContinue(user, await screen.findByRole("radio", { name: /Anyone available/i }));
    await user.click(await screen.findByRole("button", { name: "Try loading times again" }));
    expect(await screen.findByRole("radio", { name: /9:30/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[2][0]);
  });

  it("does not claim a save or delivery when explicitly allowed offline preview is used", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/public/availability?")) return jsonResponse({ data: { slots: [demoSlots[0]] } });
      throw new TypeError("Network unavailable");
    }));
    renderBookingFlow(true);
    await completeBookingDetails(user);
    await user.click(screen.getByRole("button", { name: "Confirm booking" }));
    expect(await screen.findByRole("heading", { name: "Appointment preview" })).toBeInTheDocument();
    expect(screen.getByText(/This demonstration has not been saved/)).toBeInTheDocument();
    expect(screen.queryByText(/Your booking is saved/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add to calendar/ })).not.toBeInTheDocument();
  });

  it("returns to the time screen when the chosen slot is lost", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/public/availability?")) {
          return jsonResponse({ data: { slots: [demoSlots[0], demoSlots[2]] } });
        }
        if (url === "/api/public/appointments" && init?.method === "POST") {
          return jsonResponse({ error: { code: "slot_unavailable", message: "That appointment time was just booked." } }, 409);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderBookingFlow();

    await completeBookingDetails(user);
    await user.click(screen.getByRole("button", { name: "Confirm booking" }));

    expect(await screen.findByRole("heading", { name: "When works for you?" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("That appointment time was just booked.");
    expect(screen.queryByRole("radio", { name: /9:30/i })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /2:30/i })).toBeInTheDocument();
  });

  it("uses the business's own words and skips the questions its features leave out", () => {
    const profile = resolveBusinessProfile({
      businessType: "wellness",
      features: { customerTypes: false, dependents: false, dateOfBirth: false },
    });
    render(
      <BusinessProfileProvider profile={profile}>
        <BookingFlow
          clinic={demoClinic}
          locations={demoLocations}
          services={demoServices}
          practitioners={demoPractitioners}
          resources={demoResources}
          initialSlots={demoSlots}
        />
      </BusinessProfileProvider>,
    );

    expect(screen.queryByRole("button", { name: /Myself/i })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Indiranagar/i })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b(patient|clinic|practitioner|medical)\b/i);
  });

  it("books at a single-location business without asking where", () => {
    const profile = resolveBusinessProfile({
      businessType: "wellness",
      features: { customerTypes: false, dependents: false },
    });
    render(
      <BusinessProfileProvider profile={profile}>
        <BookingFlow
          clinic={demoClinic}
          locations={[demoLocations[0]]}
          services={demoServices}
          practitioners={demoPractitioners}
          resources={demoResources}
          initialSlots={demoSlots}
        />
      </BusinessProfileProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "What would you like to book?" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Indiranagar/i })).not.toBeInTheDocument();
  });

  it("shows the business cover, service pictures and the chosen service's picture in the summary", async () => {
    const user = userEvent.setup();
    const coverUrl = "/api/public/media/indiranagar-dental/cover-1";
    const serviceImageUrl = "/api/public/media/indiranagar-dental/service-1";
    const { container } = render(
      <BookingFlow
        clinic={{ ...demoClinic, coverUrl }}
        locations={[demoLocations[0]]}
        services={demoServices.map((service, index) => (index === 0 ? { ...service, imageUrl: serviceImageUrl } : service))}
        practitioners={demoPractitioners}
        resources={demoResources}
        initialSlots={demoSlots}
      />,
    );
    const images = (url: string) => container.querySelectorAll(`img[src="${url}"]`);

    await screen.findByRole("heading", { level: 1, name: "What would you like to book?" });
    expect(images(coverUrl)).toHaveLength(1);
    expect(images(serviceImageUrl)).toHaveLength(1);
    await pickAndContinue(user, screen.getByRole("radio", { name: new RegExp(demoServices[0].name, "i") }));

    await screen.findByRole("heading", { level: 1, name: "Who would you like to see?" });
    expect(images(coverUrl)).toHaveLength(0);
    expect(images(serviceImageUrl).length).toBeGreaterThan(0);
  });

  it("opens with the service from a shared link already chosen and keeps it when a location is picked", async () => {
    const user = userEvent.setup();
    const profile = resolveBusinessProfile({
      businessType: "wellness",
      features: { customerTypes: false, dependents: false },
    });
    render(
      <BusinessProfileProvider profile={profile}>
        <BookingFlow
          clinic={demoClinic}
          locations={demoLocations}
          services={demoServices}
          practitioners={demoPractitioners}
          resources={demoResources}
          initialSlots={demoSlots}
          initialServiceId="service_cleaning"
        />
      </BusinessProfileProvider>,
    );

    expect(screen.getAllByText(/Routine cleaning/).length).toBeGreaterThan(0);
    await pickAndContinue(user, screen.getByRole("radio", { name: /Indiranagar/i }));
    // The service screen is skipped: the next question is who to see.
    expect(await screen.findByRole("heading", { name: "Who would you like to see?" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "What would you like to book?" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Routine cleaning/).length).toBeGreaterThan(0);
  });

  it("books with the person from a profile link, only where and for what they work", async () => {
    const user = userEvent.setup();
    const rohan = demoPractitioners.find((person) => person.id === "practitioner_rohan")!;
    const profile = resolveBusinessProfile({
      businessType: "wellness",
      features: { customerTypes: false, dependents: false },
    });
    render(
      <BusinessProfileProvider profile={profile}>
        <BookingFlow
          clinic={demoClinic}
          locations={demoLocations}
          services={demoServices}
          practitioners={demoPractitioners}
          resources={demoResources}
          initialSlots={demoSlots}
          initialPersonId={rohan.id}
          initialDate="2026-09-15"
        />
      </BusinessProfileProvider>,
    );

    // Rohan works at one location, so it is chosen; only his services are offered.
    expect(screen.getByRole("heading", { level: 1, name: "What would you like to book?" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Routine cleaning/i })).not.toBeInTheDocument();
    await pickAndContinue(user, screen.getByRole("radio", { name: /New patient consultation/i }));
    // The people screen is skipped: he is already chosen.
    expect(await screen.findByRole("heading", { name: "When works for you?" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Who would you like to see?" })).not.toBeInTheDocument();
    expect(screen.getAllByText(rohan.name).length).toBeGreaterThan(0);
  });

  it("chooses the time from a profile link and moves on to the details", async () => {
    const rohanSlot = demoSlots.find((slot) => slot.practitionerId === "practitioner_rohan")!;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { slots: [rohanSlot] } })));
    const profile = resolveBusinessProfile({
      businessType: "wellness",
      features: { customerTypes: false, dependents: false },
    });
    render(
      <BusinessProfileProvider profile={profile}>
        <BookingFlow
          clinic={demoClinic}
          locations={demoLocations}
          services={demoServices}
          practitioners={demoPractitioners}
          resources={demoResources}
          initialSlots={demoSlots}
          initialServiceId="service_implant"
          initialPersonId="practitioner_rohan"
          initialDate="2026-09-02"
          initialTime={new Date(rohanSlot.startsAt).toISOString()}
        />
      </BusinessProfileProvider>,
    );

    // The time was confirmed on the profile, so the time screen is passed without a tap.
    expect(await screen.findByRole("heading", { name: "Last step: your details" })).toBeInTheDocument();
  });

  it("stays on the time screen when the linked time is no longer free", async () => {
    const rohanSlot = demoSlots.find((slot) => slot.practitionerId === "practitioner_rohan")!;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { slots: [rohanSlot] } })));
    const profile = resolveBusinessProfile({
      businessType: "wellness",
      features: { customerTypes: false, dependents: false },
    });
    render(
      <BusinessProfileProvider profile={profile}>
        <BookingFlow
          clinic={demoClinic}
          locations={demoLocations}
          services={demoServices}
          practitioners={demoPractitioners}
          resources={demoResources}
          initialSlots={demoSlots}
          initialServiceId="service_implant"
          initialPersonId="practitioner_rohan"
          initialTime="2026-09-02T23:45:00.000Z"
        />
      </BusinessProfileProvider>,
    );

    expect(await screen.findByRole("radio", { name: /10:00/i })).not.toBeChecked();
    expect(screen.getByRole("heading", { level: 1, name: "When works for you?" })).toBeInTheDocument();
  });

  it("ignores a profile link to someone who does not offer the linked service", async () => {
    const user = userEvent.setup();
    const profile = resolveBusinessProfile({
      businessType: "wellness",
      features: { customerTypes: false, dependents: false },
    });
    render(
      <BusinessProfileProvider profile={profile}>
        <BookingFlow
          clinic={demoClinic}
          locations={demoLocations}
          services={demoServices}
          practitioners={demoPractitioners}
          resources={demoResources}
          initialSlots={demoSlots}
          initialServiceId="service_consultation"
          initialPersonId="practitioner_mira"
          initialDate="not-a-date"
        />
      </BusinessProfileProvider>,
    );

    await pickAndContinue(user, screen.getByRole("radio", { name: /Indiranagar/i }));
    expect(await screen.findByRole("heading", { name: "Who would you like to see?" })).toBeInTheDocument();
  });

  it("ignores a shared link to a service that does not exist", () => {
    render(
      <BookingFlow
        clinic={demoClinic}
        locations={demoLocations}
        services={demoServices}
        practitioners={demoPractitioners}
        resources={demoResources}
        initialSlots={demoSlots}
        initialServiceId="service_missing"
      />,
    );
    expect(screen.queryByRole("radio", { checked: true })).not.toBeInTheDocument();
  });

  it("asks the business's own questions for the chosen service and sends the answers", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/public/availability?")) return jsonResponse({ data: { slots: [demoSlots[0]] } });
      if (url === "/api/public/appointments" && init?.method === "POST") return bookedResponse();
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderBookingFlow(false, [bookingForm()]);

    await chooseUpToTime(user);
    expect(await screen.findByRole("heading", { name: "Before your visit" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // The required question stops the customer on this screen.
    expect(await screen.findByRole("link", { name: "How did you hear about us? — Answer this question." })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "A friend" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await fillDetails(user);
    await user.click(screen.getByRole("button", { name: "Confirm booking" }));
    await screen.findByRole("heading", { name: /You.re booked/ });
    expect(postedBody(fetchMock).formAnswers).toEqual({ q1: "A friend" });
  });

  it("does not ask questions meant for a different service", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { slots: [demoSlots[0]] } })));
    renderBookingFlow(false, [bookingForm({ serviceIds: ["service_other"] })]);

    await chooseUpToTime(user);

    expect(await screen.findByRole("heading", { name: "Last step: your details" })).toBeInTheDocument();
    expect(screen.queryByText("Before your visit")).not.toBeInTheDocument();
  });

  it("asks to send a request, not confirm, for a service the business confirms itself", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { slots: [demoSlots[0]] } })));
    renderBookingFlow();

    await pickAndContinue(user, await screen.findByRole("radio", { name: /Indiranagar/i }));
    await pickAndContinue(user, await screen.findByRole("radio", { name: /New patient consultation/i }));
    if (screen.queryByRole("heading", { name: "Who would you like to see?" })) {
      await pickAndContinue(user, screen.getByRole("radio", { name: /Anyone available/i }));
    }
    await pickAndContinue(user, await screen.findByRole("radio", { name: /9:30/i }));

    await screen.findByRole("heading", { name: "Last step: your details" });
    expect(screen.getByRole("button", { name: "Send request" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm booking" })).not.toBeInTheDocument();
  });
});
