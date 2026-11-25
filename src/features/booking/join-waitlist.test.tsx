/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoClinic, demoLocations, demoPractitioners, demoServices } from "@/lib/demo-data";

import { dayIn, JoinWaitlist } from "./join-waitlist";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const service = demoServices[0]!;
const location = demoLocations[0]!;
const people = demoPractitioners.slice(0, 2);

async function open() {
  const user = userEvent.setup();
  render(<JoinWaitlist clinic={demoClinic} service={service} location={location} people={people} />);
  await user.click(screen.getByRole("button", { name: /Join the waitlist/ }));
  await screen.findByRole("dialog");
  return user;
}

describe("joining the waitlist from the booking page", () => {
  it("invites someone whose times do not suit and opens a form with dates, time of day and consent", async () => {
    await open();
    expect(screen.getByText("No time suits you?")).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("Until")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Time of day" })).toBeInTheDocument();
    expect(screen.getByText(/Leave all unticked for any/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Message me on WhatsApp/ })).toBeInTheDocument();
  });

  it("sends the choices to the waitlist route with the bot filters and shows what happens next", async () => {
    const fetchMock = vi.fn(async () => json({ data: { entryId: "e1", updated: false } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const user = await open();
    await user.click(screen.getByRole("radio", { name: /Afternoon/ }));
    await user.click(screen.getByRole("checkbox", { name: people[0]!.name }));
    await user.type(screen.getByLabelText("First name"), "Priya");
    await user.type(screen.getByLabelText("Last name"), "Shah");
    await user.type(screen.getByLabelText("Email"), "priya@example.com");
    await user.click(screen.getByRole("checkbox", { name: /I agree that/ }));
    await user.click(screen.getByRole("button", { name: "Join the waitlist" }));

    expect(await screen.findByText("You are on the waitlist")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is booked until you do/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/public/waitlist");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      clinicSlug: demoClinic.slug, serviceId: service.id, locationId: location.id, practitionerIds: [people[0]!.id], timePreference: "afternoon",
      firstName: "Priya", lastName: "Shah", email: "priya@example.com", acceptedPrivacyNotice: true, messagingConsent: false,
    });
    expect(typeof body.fillMs).toBe("number");
    expect(body.dateFrom).toBe(dayIn(location.timezone || demoClinic.timezone, 1));
  });

  it("does not send until the details are complete, and names what is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Join the waitlist" }));
    expect(await screen.findByText("Enter your first name.")).toBeInTheDocument();
    expect(screen.getByText("Enter your last name.")).toBeInTheDocument();
    expect(screen.getByText(/Enter an email, or a phone number/)).toBeInTheDocument();
    expect(screen.getByText("Agree to this use of your details to join.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's reason and keeps what was typed when joining fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "rate_limited", message: "Too many waitlist sign-ups from this network. Try again later or call to join." } }, 429)));
    const user = await open();
    await user.type(screen.getByLabelText("First name"), "Priya");
    await user.type(screen.getByLabelText("Last name"), "Shah");
    await user.type(screen.getByLabelText("Email"), "priya@example.com");
    await user.click(screen.getByRole("checkbox", { name: /I agree that/ }));
    await user.click(screen.getByRole("button", { name: "Join the waitlist" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many waitlist sign-ups/);
    await waitFor(() => expect(screen.getByLabelText("First name")).toHaveValue("Priya"));
  });

  it("says the request was updated when the person was already waiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: { entryId: "e1", updated: true } }, 201)));
    const user = await open();
    await user.type(screen.getByLabelText("First name"), "Priya");
    await user.type(screen.getByLabelText("Last name"), "Shah");
    await user.type(screen.getByLabelText("Email"), "priya@example.com");
    await user.click(screen.getByRole("checkbox", { name: /I agree that/ }));
    await user.click(screen.getByRole("button", { name: "Join the waitlist" }));
    expect(await screen.findByText("Your waitlist request is updated")).toBeInTheDocument();
  });
});

describe("dayIn", () => {
  it("reads today on the place's own calendar", () => {
    const at = Date.parse("2026-11-20T20:00:00Z"); // already 21 November in India
    expect(dayIn("Asia/Kolkata", 0, at)).toBe("2026-11-21");
    expect(dayIn("UTC", 0, at)).toBe("2026-11-20");
    expect(dayIn("UTC", 14, at)).toBe("2026-12-04");
  });
});
