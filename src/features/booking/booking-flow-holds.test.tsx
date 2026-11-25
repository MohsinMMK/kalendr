/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { demoClinic, demoLocations, demoPractitioners, demoResources, demoServices, demoSlots } from "@/lib/demo-data";
import { publicBookingSchema } from "@/lib/contracts";

import { BookingFlow } from "./booking-flow";
import { render } from "./test-support";

vi.mock("./visitor-zone", () => ({ detectVisitorZone: () => "Asia/Kolkata", detectVisitorLocale: () => "en-IN" }));

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type User = ReturnType<typeof userEvent.setup>;

/** Picking moves on by itself; the screen has moved on once the choice is gone. */
async function pickAndContinue(user: User, choice: HTMLElement) {
  await user.click(choice);
  await waitFor(() => expect(choice).not.toBeInTheDocument());
}

async function chooseUpToTimeScreen(user: User) {
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Indiranagar/i }));
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Routine cleaning/i }));
  await pickAndContinue(user, await screen.findByRole("radio", { name: /Anyone available/i }));
  await screen.findByRole("heading", { name: "When works for you?" });
}

function mount() {
  render(
    <BookingFlow
      clinic={demoClinic}
      locations={demoLocations}
      services={demoServices}
      practitioners={demoPractitioners}
      resources={demoResources}
      initialSlots={demoSlots}
    />,
  );
}

const holdPosts = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/public/holds" && (init as RequestInit | undefined)?.method === "POST");
const holdDeletes = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/public/holds" && (init as RequestInit | undefined)?.method === "DELETE");

function stubServer(options: { holdStatus?: number; expiresInMs?: number } = {}) {
  let count = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/public/availability?")) return jsonResponse({ data: { slots: [demoSlots[0], demoSlots[2]] } });
    if (url === "/api/public/holds" && init?.method === "POST") {
      if (options.holdStatus === 409) return jsonResponse({ error: { code: "slot_unavailable", message: "taken" } }, 409);
      count += 1;
      return jsonResponse({ data: { holdToken: `hold-token-number-${count}-xxxxxxxxxxxx`, expiresAt: new Date(Date.now() + (options.expiresInMs ?? 300_000)).toISOString() } }, 201);
    }
    if (url === "/api/public/holds" && init?.method === "DELETE") return jsonResponse({ data: { released: true } });
    if (url === "/api/public/appointments" && init?.method === "POST") {
      return jsonResponse({ data: { appointmentId: "appointment_created", manageToken: "manage-created", status: "booked", startsAt: demoSlots[0].startsAt, endsAt: demoSlots[0].endsAt } }, 201);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("holding the picked time", () => {
  it("holds the time when it is picked, counts down on the next screen, and sends the token with the booking", async () => {
    const user = userEvent.setup();
    const fetchMock = stubServer();
    mount();
    await chooseUpToTimeScreen(user);

    await user.click(await screen.findByRole("radio", { name: /9:30/i }));
    await screen.findByRole("heading", { name: "Last step: your details" });

    const [, init] = holdPosts(fetchMock)[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      clinicSlug: demoClinic.slug,
      locationId: "loc_indiranagar",
      serviceId: "service_cleaning",
      practitionerId: demoSlots[0].practitionerId,
      startsAt: demoSlots[0].startsAt,
      endsAt: demoSlots[0].endsAt,
    });
    expect(await screen.findByText(/Time held for you/)).toBeInTheDocument();
    expect(screen.getByText(/left$/)).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Full name" }), "Ananya Rao");
    await user.type(screen.getByRole("textbox", { name: "Mobile number" }), "+91 98450 12345");
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "ananya@example.com");
    await user.click(screen.getByRole("checkbox", { name: /I understand and agree to this use of the booking details/i }));
    await user.click(screen.getByRole("button", { name: "Confirm booking" }));
    await screen.findByRole("heading", { name: /You.re booked/ });

    const post = fetchMock.mock.calls.find(([input, request]) => String(input) === "/api/public/appointments" && (request as RequestInit).method === "POST");
    const body = JSON.parse(String((post?.[1] as RequestInit).body));
    expect(body.holdToken).toBe("hold-token-number-1-xxxxxxxxxxxx");
    expect(publicBookingSchema.safeParse(body).success).toBe(true);
    // The booking took the hold over, so nothing is released.
    expect(holdDeletes(fetchMock)).toHaveLength(0);
  });

  it("says so and asks again when someone else just took the time", async () => {
    const user = userEvent.setup();
    stubServer({ holdStatus: 409 });
    mount();
    await chooseUpToTimeScreen(user);

    await user.click(await screen.findByRole("radio", { name: /9:30/i }));

    expect(await screen.findByText("Someone just took that time. Please pick another.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "When works for you?" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /9:30/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Time held for you/)).not.toBeInTheDocument();
  });

  it("lets the first hold go when another time is picked, and when the customer goes back before the time screen", async () => {
    const user = userEvent.setup();
    const fetchMock = stubServer();
    mount();
    await chooseUpToTimeScreen(user);

    await user.click(await screen.findByRole("radio", { name: /9:30/i }));
    await screen.findByRole("heading", { name: "Last step: your details" });
    await user.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "When works for you?" });
    await user.click(await screen.findByRole("radio", { name: /2:30/i }));
    await waitFor(() => expect(holdPosts(fetchMock)).toHaveLength(2));
    const second = JSON.parse(String((holdPosts(fetchMock)[1][1] as RequestInit).body));
    expect(second.replaceToken).toBe("hold-token-number-1-xxxxxxxxxxxx");

    await screen.findByRole("heading", { name: "Last step: your details" });
    await user.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: "When works for you?" });
    await user.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: /Who would you like to see|Who/ });
    await waitFor(() => expect(holdDeletes(fetchMock)).toHaveLength(1));
    const released = JSON.parse(String((holdDeletes(fetchMock)[0][1] as RequestInit).body));
    expect(released).toEqual({ clinicSlug: demoClinic.slug, holdToken: "hold-token-number-2-xxxxxxxxxxxx" });
    expect((holdDeletes(fetchMock)[0][1] as RequestInit).keepalive).toBe(true);
  });

  it("releases the hold when the page is left", async () => {
    const user = userEvent.setup();
    const fetchMock = stubServer();
    mount();
    await chooseUpToTimeScreen(user);
    await user.click(await screen.findByRole("radio", { name: /9:30/i }));
    await screen.findByText(/Time held for you/);

    cleanup();
    expect(holdDeletes(fetchMock)).toHaveLength(1);
  });

  it("clears the time with a clear message when the hold runs out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    stubServer({ expiresInMs: 12_000 });
    mount();
    await chooseUpToTimeScreen(user);
    await user.click(await screen.findByRole("radio", { name: /9:30/i }));
    await screen.findByRole("heading", { name: "Last step: your details" });
    await screen.findByText(/Time held for you/);

    await act(async () => {
      vi.advanceTimersByTime(13_000);
    });

    expect(await screen.findByText(/has been released\. Please pick a time again/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "When works for you?" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /9:30/i, checked: true })).not.toBeInTheDocument();
  });
});
