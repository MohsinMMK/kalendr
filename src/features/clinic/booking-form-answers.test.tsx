/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BookingFormAnswers } from "./booking-form-answers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response);
}

describe("BookingFormAnswers", () => {
  it("shows each question with the customer's answer", async () => {
    const fetchMock = respond(200, {
      data: {
        name: "Before your appointment",
        fields: [
          { id: "q1", type: "single_choice", label: "How did you hear about us?", required: true, options: ["A friend", "Online"] },
          { id: "q2", type: "long_text", label: "Anything we should know?", required: false },
          { id: "q3", type: "consent", label: "I agree to the cancellation policy", required: true },
        ],
        answers: { q1: "A friend", q3: true },
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BookingFormAnswers appointmentId="apt_1" />);

    expect(await screen.findByRole("heading", { name: "Before your appointment" })).toBeInTheDocument();
    expect(screen.getByText("A friend")).toBeInTheDocument();
    expect(screen.getByText("No answer")).toBeInTheDocument();
    expect(screen.getByText("Agreed")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/staff/appointments/apt_1/form", expect.anything());
  });

  it("shows nothing when the booking had no form", async () => {
    const fetchMock = respond(200, { data: null });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<BookingFormAnswers appointmentId="apt_2" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("says so when the answers cannot be loaded", async () => {
    vi.stubGlobal("fetch", respond(500, {}));
    render(<BookingFormAnswers appointmentId="apt_3" />);
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
  });
});
