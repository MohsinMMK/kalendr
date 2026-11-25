import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Booker, type BookerEvent } from "./index";

const catalog = {
  business: { name: "Lotus Dental", timezone: "Asia/Kolkata" },
  locations: [{ id: "loc_1", name: "Main", timezone: "Asia/Kolkata" }],
  services: [{ id: "svc_1", name: "Check-up", description: "", durationMinutes: 15, priceLabel: null, priceMinor: null, category: null, personIds: ["p_1"], locationIds: ["loc_1"] }],
  people: [{ id: "p_1", name: "Dr Rao", title: "Dentist", specialty: "General" }],
};
const slot = { id: "slot_1", startsAt: "2026-12-01T05:30:00.000Z", endsAt: "2026-12-01T05:45:00.000Z", practitionerId: "p_1" };

function fakeFetch(bookingReply: () => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.includes("/api/public/catalog")) return Response.json({ data: catalog });
    if (url.includes("/api/public/availability")) return Response.json({ data: { slots: [slot], outOfOffice: [], fullDays: [] } });
    if (url.includes("/api/public/appointments")) return bookingReply();
    return new Response("{}", { status: 404 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

async function fillDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /check-up/i }));
  await user.click(await screen.findByRole("button", { name: /11:00 am/i }));
  await user.type(screen.getByLabelText("Full name"), "Asha Verma");
  await user.type(screen.getByLabelText("Email"), "asha.verma@example.com");
  await user.type(screen.getByLabelText("Phone"), "+919000000123");
  await user.click(screen.getByRole("checkbox", { name: /i understand and agree/i }));
}

afterEach(cleanup);

describe("Booker", () => {
  it("books through the public API and reports events with no personal details", async () => {
    const { impl, calls } = fakeFetch(() => Response.json({ data: { appointmentId: "appt_9", status: "booked", startsAt: slot.startsAt } }, { status: 201 }));
    const events: BookerEvent[] = [];
    const user = userEvent.setup();
    render(<Booker clinicSlug="lotus-dental" baseUrl="https://book.example.com" fetch={impl} onEvent={(event) => events.push(event)} />);
    await fillDetails(user);
    await user.click(screen.getByRole("button", { name: /confirm booking/i }));

    expect(await screen.findByTestId("booker-reference")).toHaveTextContent("appt_9");
    const post = calls.find((call) => call.url.endsWith("/api/public/appointments"));
    expect(post?.url).toBe("https://book.example.com/api/public/appointments");
    expect(new Headers(post?.init?.headers).get("idempotency-key")).toMatch(/[0-9a-f-]{36}/);
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({ clinicSlug: "lotus-dental", serviceId: "svc_1", slotId: "slot_1", firstName: "Asha", lastName: "Verma", acceptedPrivacyNotice: true });

    expect(events.map((event) => event.type)).toEqual(["opened", "service_selected", "slot_selected", "booked"]);
    const serialised = JSON.stringify(events);
    expect(serialised).not.toMatch(/Asha|Verma|asha|9000000123/);
    expect(events.at(-1)).toMatchObject({ appointmentId: "appt_9", startsAt: slot.startsAt });
  });

  it("does not book until the customer agrees to the privacy notice themselves", async () => {
    const { impl, calls } = fakeFetch(() => Response.json({ data: { appointmentId: "appt_9", status: "booked", startsAt: slot.startsAt } }, { status: 201 }));
    const user = userEvent.setup();
    render(<Booker clinicSlug="lotus-dental" baseUrl="" fetch={impl} />);
    await fillDetails(user);
    await user.click(screen.getByRole("checkbox", { name: /i understand and agree/i }));
    expect(screen.getByRole("checkbox", { name: /i understand and agree/i })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: /confirm booking/i }));
    expect(calls.some((call) => call.url.endsWith("/api/public/appointments"))).toBe(false);
  });

  it("sends the customer back to pick another time when the slot was taken", async () => {
    const { impl } = fakeFetch(() => Response.json({ error: { code: "slot_unavailable", message: "That time is no longer available." } }, { status: 409 }));
    const events: BookerEvent[] = [];
    const user = userEvent.setup();
    render(<Booker clinicSlug="lotus-dental" baseUrl="" fetch={impl} onEvent={(event) => events.push(event)} />);
    await fillDetails(user);
    await user.click(screen.getByRole("button", { name: /confirm booking/i }));

    expect(await screen.findByText("That time is no longer available.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /pick a time/i })).toBeInTheDocument();
    expect(events.at(-1)).toEqual({ type: "failed", serviceId: "svc_1", errorCode: "slot_unavailable" });
  });

  it("shows an error with a way to retry when the business cannot be loaded", async () => {
    let attempts = 0;
    const impl = (async () => {
      attempts += 1;
      return attempts === 1 ? Response.json({ error: { code: "clinic_not_found", message: "Business not found." } }, { status: 404 }) : Response.json({ data: catalog });
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<Booker clinicSlug="lotus-dental" baseUrl="" fetch={impl} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Business not found.");
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /check-up/i })).toBeInTheDocument());
  });
});
