/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render as plainRender, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoClinic, demoLocations, demoPractitioners, demoResources, demoServices, demoSlots } from "@/lib/demo-data";
import type { Service } from "@/lib/domain";

import { BookingFlow } from "./booking-flow";
import { PublicCodeField, type AppliedCode } from "./public-code-field";
import { render } from "./test-support";

vi.mock("./visitor-zone", () => ({ detectVisitorZone: () => "Asia/Kolkata", detectVisitorLocale: () => "en-IN" }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const respond = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const valid = { data: { valid: true, description: "10% off", discountMinor: 8_000, netMinor: 72_000, currency: "INR" } };
const invalid = { data: { valid: false, message: "That code isn't valid for this booking." } };

function Field({ serverError }: { serverError?: string }) {
  const [applied, setApplied] = useState<AppliedCode | null>(null);
  return <PublicCodeField clinicSlug="lotus" serviceId="svc1" applied={applied} onApplied={setApplied} serverError={serverError} />;
}

describe("the code field on a booking page", () => {
  it("is a quiet link until opened, and sends nothing until the customer applies a code", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => respond(valid));
    vi.stubGlobal("fetch", fetchMock);
    plainRender(<Field />);
    expect(screen.queryByRole("textbox", { name: "Code" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Have a code?" }));
    await user.type(await screen.findByRole("textbox", { name: "Code" }), "welcome10");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ clinicSlug: "lotus", serviceId: "svc1", code: "welcome10" });
  });

  it("shows what the code does and the price after it when the answer is valid, and lets the customer remove it", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => respond(valid)));
    plainRender(<Field />);
    await user.click(screen.getByRole("button", { name: "Have a code?" }));
    await user.type(await screen.findByRole("textbox", { name: "Code" }), "welcome10");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent("welcome10: 10% off");
    expect(note).toHaveTextContent("Price ₹720 instead of ₹800");
    expect(note).toHaveTextContent("confirmed when you book");
    await user.click(within(note).getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("textbox", { name: "Code" })).toHaveValue("");
  });

  it("shows only the message it is given when the code is not valid", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => respond(invalid)));
    plainRender(<Field />);
    await user.click(screen.getByRole("button", { name: "Have a code?" }));
    const field = await screen.findByRole("textbox", { name: "Code" });
    await user.type(field, "nope");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't valid for this booking.");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says so when the check itself fails, and when the preview has no codes", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    plainRender(<Field />);
    await user.click(screen.getByRole("button", { name: "Have a code?" }));
    await user.type(await screen.findByRole("textbox", { name: "Code" }), "x1");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not check that code. Try again.");
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => respond({ error: { code: "preview_only", message: "x" } }, 409)));
    plainRender(<Field />);
    await user.click(screen.getByRole("button", { name: "Have a code?" }));
    await user.type(await screen.findByRole("textbox", { name: "Code" }), "x1");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Codes are not available in the preview.");
  });

  it("shows a refusal the booking gave for the code", () => {
    plainRender(<Field serverError="This code has been used as many times as it allows." />);
    expect(screen.getByRole("alert")).toHaveTextContent("used as many times");
  });
});

const priced: Service[] = demoServices.map((service) => ({ ...service, priceMinor: 80_000, payment: { mode: "deposit", priceMinor: 80_000, depositMinor: 20_000, dueNowMinor: 20_000, dueLaterMinor: 60_000, currency: "INR", policyText: "Policy words." } }));

describe("the code in the booking flow", () => {
  it("sends the code with the booking and follows the server's amount to pay", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/public/availability?")) return respond({ data: { slots: [demoSlots[0], demoSlots[2]] } });
      if (url === "/api/public/holds" && init?.method === "POST") return respond({ data: { holdToken: "hold-token-number-1-xxxxxxxxxxxx", expiresAt: new Date(Date.now() + 300_000).toISOString() } }, 201);
      if (url === "/api/public/coupons/validate") return respond(valid);
      if (url === "/api/public/appointments" && init?.method === "POST") {
        return respond({ data: { appointmentId: "appointment_pending", manageToken: "manage-token-for-payment-1234", status: "pending_payment", startsAt: demoSlots[0].startsAt, endsAt: demoSlots[0].endsAt, payment: { dueNowMinor: 15_000, currency: "INR", expiresAt: new Date(Date.now() + 600_000).toISOString(), policyText: "Policy words." } } }, 201);
      }
      return respond({ data: {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BookingFlow clinic={demoClinic} locations={demoLocations} services={priced} practitioners={demoPractitioners} resources={demoResources} initialSlots={demoSlots} />);
    const next = async (choice: HTMLElement) => { await user.click(choice); await waitFor(() => expect(choice).not.toBeInTheDocument()); };
    await next(await screen.findByRole("radio", { name: /Indiranagar/i }));
    await next(await screen.findByRole("radio", { name: /Routine cleaning/i }));
    await next(await screen.findByRole("radio", { name: /Anyone available/i }));
    await next(await screen.findByRole("radio", { name: /9:30/i }));
    await screen.findByRole("heading", { name: "Last step: your details" });
    await user.type(screen.getByRole("textbox", { name: "Full name" }), "Ananya Rao");
    await user.type(screen.getByRole("textbox", { name: "Mobile number" }), "+91 98450 12345");
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "ananya@example.com");
    await user.click(screen.getByRole("checkbox", { name: /I understand and agree to this use of the booking details/i }));
    await user.click(screen.getByRole("checkbox", { name: "I agree to this policy" }));

    await user.click(screen.getByRole("button", { name: "Have a code?" }));
    await user.type(await screen.findByRole("textbox", { name: "Code" }), "welcome10");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/Price ₹720 instead of ₹800/)).toBeInTheDocument();

    await act(async () => { await user.click(screen.getByRole("button", { name: "Confirm booking" })); });
    const call = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/public/appointments" && (init as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((call[1] as RequestInit).body)).couponCode).toBe("welcome10");
    // The amount comes from the booking's answer (₹150), not from the preview above (₹200 deposit).
    expect(await screen.findByRole("heading", { level: 1, name: "Pay ₹150 to keep your appointment" })).toBeInTheDocument();
  });
});
