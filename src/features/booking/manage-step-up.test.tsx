/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoAppointments, demoClinic, demoLocations, demoPractitioners, demoServices, demoSlots } from "@/lib/demo-data";

import type { ManageBookingSnapshot } from "./booking-types";
import { ManageBooking } from "./manage-booking";
import { ManageLinkExpired } from "./manage-link-expired";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const refusal = (code: string, message: string, status = 403) => json({ error: { code, message } }, status);

function snapshot(): ManageBookingSnapshot {
  const appointment = demoAppointments.find((item) => item.manageToken === "demo-booking")!;
  return {
    appointment: { ...appointment, version: 3 },
    clinic: demoClinic,
    location: demoLocations.find((item) => item.id === appointment.locationId)!,
    practitioner: demoPractitioners.find((item) => item.id === appointment.practitionerId)!,
    service: demoServices.find((item) => item.id === appointment.serviceId)!,
    canCancel: true,
    canReschedule: true,
  };
}

const base = "/api/public/appointments/demo-booking";

async function typeCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  const boxes = await screen.findAllByRole("textbox");
  await user.click(boxes[0]);
  await user.keyboard(code);
}

describe("manage link step-up", () => {
  it("asks for a code only after the server says so, then retries the cancel once", async () => {
    const user = userEvent.setup();
    const snap = snapshot();
    let patches = 0;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === base && !init?.method) return json({ data: snap });
      if (url === base && init?.method === "PATCH") {
        patches += 1;
        if (patches === 1) return refusal("step_up_required", "Enter a code first.");
        return json({ data: { appointmentId: snap.appointment.id, status: "cancelled", startsAt: snap.appointment.startsAt, endsAt: snap.appointment.endsAt, version: 4 } });
      }
      if (url === `${base}/step-up`) return json({ data: { sent: true, hint: "•••• 1234" } }, 202);
      if (url === `${base}/step-up/verify`) return json({ data: { verified: true } });
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<ManageBooking token="demo-booking" initialSnapshot={snap} fallbackSlots={demoSlots} />);
    await user.click(await screen.findByRole("button", { name: "Cancel appointment" }));
    await user.click(screen.getByRole("radio", { name: "I can't make it" }));
    expect(calls.some((call) => call.includes("step-up"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel my appointment" }));

    expect(await screen.findByText("Code sent to •••• 1234")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send a new code" })).toBeInTheDocument();
    await typeCode(user, "123456");

    await waitFor(() => expect(patches).toBe(2));
    expect(await screen.findByRole("status")).toHaveTextContent("The appointment has been cancelled.");
  });

  it("shows the wait message for a wrong code and keeps the boxes", async () => {
    const user = userEvent.setup();
    const snap = snapshot();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === base && !init?.method) return json({ data: snap });
      if (url === base && init?.method === "PATCH") return refusal("step_up_required", "x");
      if (url === `${base}/step-up`) return json({ data: { sent: true, hint: "a•••@mail.com" } }, 202);
      if (url === `${base}/step-up/verify`) return refusal("code_retry_later", "Wait 30 seconds before trying again.", 429);
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<ManageBooking token="demo-booking" initialSnapshot={snap} fallbackSlots={demoSlots} />);
    await user.click(await screen.findByRole("button", { name: "Cancel appointment" }));
    await user.click(screen.getByRole("radio", { name: "I can't make it" }));
    await user.click(screen.getByRole("button", { name: "Cancel my appointment" }));
    await typeCode(user, "000000");
    expect(await screen.findByText("Wait 30 seconds before trying again.")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(6);
  });

  it("changes contact details, asking for a code on step_up_required", async () => {
    const user = userEvent.setup();
    const snap = snapshot();
    let patches = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === base && !init?.method) return json({ data: snap });
      if (url === `${base}/contact`) {
        patches += 1;
        expect(JSON.parse(String(init?.body))).toEqual({ email: "new@example.com" });
        return patches === 1 ? refusal("step_up_required", "x") : json({ data: { updated: true } });
      }
      if (url === `${base}/step-up`) {
        expect(JSON.parse(String(init?.body))).toEqual({ action: "contact" });
        return json({ data: { sent: true, hint: "•••• 9" } }, 202);
      }
      if (url === `${base}/step-up/verify`) return json({ data: { verified: true } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<ManageBooking token="demo-booking" initialSnapshot={snap} fallbackSlots={demoSlots} />);
    await user.click(await screen.findByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Change contact details" }));
    expect(screen.getByText("We will also tell you on your other contact that this changed.")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/New email/), "new@example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await typeCode(user, "654321");
    expect(await screen.findByRole("status")).toHaveTextContent("Your contact details were changed.");
    expect(patches).toBe(2);
  });

  it("switches to the new link after a reschedule without losing the page", async () => {
    const user = userEvent.setup();
    const snap = snapshot();
    const open = demoSlots
      .filter((slot) => slot.practitionerId === snap.practitioner.id && slot.startsAt !== snap.appointment.startsAt)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const replaceState = vi.spyOn(window.history, "replaceState");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === base && !init?.method) return json({ data: snap });
      if (url.startsWith("/api/public/availability?")) return json({ data: { slots: open } });
      if (url === base && init?.method === "PATCH") {
        return json({ data: { appointmentId: snap.appointment.id, status: "booked", startsAt: open[0].startsAt, endsAt: open[0].endsAt, version: 4, manageToken: "new-token" } });
      }
      if (url === "/api/public/appointments/new-token/contact") return json({ data: { updated: true } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<ManageBooking token="demo-booking" initialSnapshot={snap} fallbackSlots={demoSlots} />);
    await user.click(await screen.findByRole("button", { name: "Change time" }));
    await user.click((await screen.findAllByRole("radio"))[0]);
    await user.click(screen.getByRole("button", { name: "Move appointment" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your appointment has been moved to the new time.");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/manage/new-token");

    // Later calls use the new token.
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Change contact details" }));
    await user.type(screen.getByLabelText(/New phone/), "+919876543210");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toContain("PATCH /api/public/appointments/new-token/contact"));
    replaceState.mockRestore();
  });

  it("shows the expired panel when the link has expired, with no booking details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => refusal("manage_link_expired", "expired", 410)));
    render(<ManageBooking token="old" fallbackSlots={[]} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in to see this booking" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/portal/sign-in");
  });
});

describe("ManageLinkExpired", () => {
  it("explains the link expired and links to sign-in", () => {
    render(<ManageLinkExpired />);
    expect(screen.getByRole("heading", { name: "Sign in to see this booking" })).toBeInTheDocument();
    expect(screen.getByText(/expired/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/portal/sign-in");
  });
});
