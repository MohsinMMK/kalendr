/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoClinic, demoLocations, demoPractitioners, demoResources, demoServices, demoSlots } from "@/lib/demo-data";
import type { Service } from "@/lib/domain";
import { publicBookingSchema } from "@/lib/contracts";
import { resolveBusinessProfile } from "@/lib/terminology";

import { BusinessProfileProvider } from "../terms/business-profile-context";
import { BookingFlow } from "./booking-flow";
import { render } from "./test-support";
import { serviceMeta } from "./booking-options";

vi.mock("./visitor-zone", () => ({ detectVisitorZone: () => "Asia/Kolkata", detectVisitorLocale: () => "en-IN" }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const baseService = demoServices.find((service) => service.id === "service_cleaning")!;

/** One person and one branch, so only the screens this feature adds can appear. */
function setup(overrides: Partial<Service>) {
  const service: Service = {
    ...baseService,
    practitionerIds: ["practitioner_asha"],
    locationIds: ["loc_indiranagar"],
    imageUrl: null,
    ...overrides,
  };
  const profile = resolveBusinessProfile({ businessType: "wellness", features: { customerTypes: false, dependents: false } });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/public/availability?")) {
      const wanted = Number(new URL(url, "http://localhost").searchParams.get("durationMinutes") ?? service.durationMinutes);
      const slot = demoSlots[0];
      return jsonResponse({ data: { slots: [{ ...slot, endsAt: new Date(Date.parse(slot.startsAt) + wanted * 60_000).toISOString() }] } });
    }
    if (url === "/api/public/appointments" && init?.method === "POST") {
      return jsonResponse({ data: { appointmentId: "appointment_created", manageToken: "manage-created", status: "booked", startsAt: demoSlots[0].startsAt, endsAt: demoSlots[0].endsAt } }, 201);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <BusinessProfileProvider profile={profile}>
      <BookingFlow
        clinic={demoClinic}
        locations={[demoLocations[0]]}
        services={[service]}
        practitioners={demoPractitioners}
        resources={demoResources}
        initialSlots={demoSlots}
        initialServiceId={service.id}
      />
    </BusinessProfileProvider>,
  );
  return fetchMock;
}

function availabilityUrls(fetchMock: ReturnType<typeof vi.fn>): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.startsWith("/api/public/availability?"))
    .map((url) => new URL(url, "http://localhost"));
}

async function fillDetailsAndBook(user: User) {
  await screen.findByRole("heading", { name: "Last step: your details" });
  await user.type(screen.getByRole("textbox", { name: "Full name" }), "Ananya Rao");
  await user.type(screen.getByRole("textbox", { name: "Mobile number" }), "+91 98450 12345");
  await user.type(screen.getByRole("textbox", { name: "Email address" }), "ananya@example.com");
  await user.click(screen.getByRole("checkbox", { name: /I understand and agree to this use of the booking details/i }));
  await user.click(screen.getByRole("button", { name: "Confirm booking" }));
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/public/appointments" && (init as RequestInit | undefined)?.method === "POST");
  expect(call).toBeDefined();
  return JSON.parse(String((call?.[1] as RequestInit).body));
}

const threeLengths = [
  { minutes: 30, priceMinor: 80_000, isDefault: false },
  { minutes: 45, priceMinor: 120_000, isDefault: true },
  { minutes: 60, priceMinor: 150_000, isDefault: false },
];

describe("service lengths", () => {
  it("sums a service with several lengths up as a range on its card text", () => {
    expect(serviceMeta({ ...baseService, lengths: threeLengths })).toBe("30–1 hr · from ₹800");
    expect(serviceMeta({ ...baseService, lengths: undefined, priceLabel: "₹800" })).toBe("45 min · ₹800");
  });

  it("shows each length with its own price and asks for new times when another length is chosen", async () => {
    const user = userEvent.setup();
    const fetchMock = setup({ lengths: threeLengths });

    expect(await screen.findByRole("heading", { name: "How long would you like?" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /30 min.*₹800/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /45 min.*₹1,200/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /1 hr.*₹1,500/ })).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /1 hr/ }));

    await screen.findByRole("radio", { name: /9:30/i });
    const urls = availabilityUrls(fetchMock);
    expect(urls.at(-1)?.searchParams.get("durationMinutes")).toBe("60");

    // Back to the length, pick a shorter one: the openings are asked for again at that length.
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(await screen.findByRole("radio", { name: /30 min/ }));
    await screen.findByRole("radio", { name: /9:30/i });
    expect(availabilityUrls(fetchMock).at(-1)?.searchParams.get("durationMinutes")).toBe("30");
  });

  it("never shows the length screen for a service with one length", async () => {
    const fetchMock = setup({ lengths: [{ minutes: 45, priceMinor: 120_000, isDefault: true }] });
    expect(await screen.findByRole("heading", { name: /Time|When|time/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "How long would you like?" })).not.toBeInTheDocument();
    expect(availabilityUrls(fetchMock).every((url) => !url.searchParams.has("durationMinutes"))).toBe(true);
  });
});

describe("how to meet", () => {
  it("tells a single plain way of meeting instead of asking, and sends it with the booking", async () => {
    const user = userEvent.setup();
    const fetchMock = setup({ locationOptions: [{ kind: "they_call", locationId: null, note: null }] });

    await screen.findByRole("radio", { name: /9:30/i });
    expect(screen.queryByRole("heading", { name: /How would you like to meet/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /9:30/i }));
    await fillDetailsAndBook(user);

    expect(await screen.findByRole("heading", { name: /You.re booked/ })).toBeInTheDocument();
    // The business number is only shown after booking.
    expect(screen.getByText(new RegExp(`Call ${demoClinic.phone.replace("+", "\\+")} at your time`))).toBeInTheDocument();
    const body = postedBody(fetchMock);
    expect(body.locationChoice).toEqual({ kind: "they_call" });
    expect(publicBookingSchema.safeParse(body).success).toBe(true);
  });

  it("asks which way to meet when there are several, and requires a choice", async () => {
    const user = userEvent.setup();
    const fetchMock = setup({
      locationOptions: [
        { kind: "in_person", locationId: "loc_indiranagar", note: null },
        { kind: "video", locationId: null, note: null },
      ],
    });

    await user.click(await screen.findByRole("radio", { name: /9:30/i }));
    expect(await screen.findByRole("heading", { name: "How would you like to meet?" })).toBeInTheDocument();
    // There is no Continue here: the screen moves on when a way is chosen.
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Video call/ }));
    await fillDetailsAndBook(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    expect(postedBody(fetchMock).locationChoice).toEqual({ kind: "video" });
  });

  it("asks for an address when the visit is at the customer's address, and will not go on without one", async () => {
    const user = userEvent.setup();
    const fetchMock = setup({ locationOptions: [{ kind: "their_address", locationId: null, note: null }] });

    await user.click(await screen.findByRole("radio", { name: /9:30/i }));
    expect(await screen.findByRole("heading", { name: "Where should we come?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getAllByText("Enter the address where we should come.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Last step: your details" })).not.toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: /Your address/ }), "12 Rose Lane, Indiranagar");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await fillDetailsAndBook(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    const body = postedBody(fetchMock);
    expect(body.locationChoice).toEqual({ kind: "their_address", detail: "12 Rose Lane, Indiranagar" });
    expect(publicBookingSchema.safeParse(body).success).toBe(true);
  });

  it("continues from the address box when Enter is pressed, but not while it is empty", async () => {
    const user = userEvent.setup();
    setup({ locationOptions: [{ kind: "their_address", locationId: null, note: null }] });

    await user.click(await screen.findByRole("radio", { name: /9:30/i }));
    const address = await screen.findByRole("textbox", { name: /Your address/ });
    await user.type(address, "{Enter}");
    expect(screen.queryByRole("heading", { name: "Last step: your details" })).not.toBeInTheDocument();

    await user.type(address, "12 Rose Lane, Indiranagar{Enter}");
    expect(await screen.findByRole("heading", { name: "Last step: your details" })).toBeInTheDocument();
  });

  it("leaves services without options exactly as before", async () => {
    const user = userEvent.setup();
    const fetchMock = setup({});
    await user.click(await screen.findByRole("radio", { name: /9:30/i }));
    await fillDetailsAndBook(user);
    await screen.findByRole("heading", { name: /You.re booked/ });
    expect(postedBody(fetchMock)).not.toHaveProperty("locationChoice");
  });
});
