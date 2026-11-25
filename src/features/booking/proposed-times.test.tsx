/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { render as renderWithAdapter } from "@testing-library/react";

import type { ApprovalSettings } from "@/lib/approval";
import { demoAppointments, demoClinic, demoLocations, demoPractitioners, demoResources, demoServices, demoSlots } from "@/lib/demo-data";
import type { TimeSlot } from "@/lib/domain";
import { publicBookingSchema } from "@/lib/contracts";

import { BookingConfirmation } from "./booking-confirmation";
import { BookingFlow } from "./booking-flow";
import type { ManageBookingSnapshot } from "./booking-types";
import { ManageBooking } from "./manage-booking";
import { render } from "./test-support";

vi.mock("./visitor-zone", () => ({ detectVisitorZone: () => "Asia/Kolkata", detectVisitorLocale: () => "en-IN" }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const asha: TimeSlot[] = demoSlots.filter((slot) => slot.practitionerId === "practitioner_asha");
// A slot with another person on the same day, which must never be offered.
const mira = demoSlots.find((slot) => slot.practitionerId === "practitioner_mira")!;
const approvalAlways: ApprovalSettings = { rule: "always", noticeHours: 24, requestsHoldSlot: true, hideLocationUntilConfirmed: false };

function servicesWith(approval?: ApprovalSettings) {
  return demoServices.map((service) => (service.id === "service_cleaning" ? { ...service, approval } : service));
}

function renderFlow(approval?: ApprovalSettings) {
  render(
    <BookingFlow
      turnstileSiteKey={null}
      clinic={demoClinic}
      locations={demoLocations}
      services={servicesWith(approval)}
      practitioners={demoPractitioners}
      resources={demoResources}
      initialSlots={[]}
    />,
  );
}

async function pick(user: ReturnType<typeof userEvent.setup>, choice: HTMLElement) {
  await user.click(choice);
  await waitFor(() => expect(choice).not.toBeInTheDocument());
}

async function reachDetails(user: ReturnType<typeof userEvent.setup>) {
  await pick(user, await screen.findByRole("radio", { name: /Indiranagar/i }));
  await pick(user, await screen.findByRole("radio", { name: /Routine cleaning/i }));
  await pick(user, await screen.findByRole("radio", { name: /Anyone available/i }));
  await pick(user, await screen.findByRole("radio", { name: /9:30/i }));
  await screen.findByRole("heading", { name: "Last step: your details" });
}

describe("proposed times in the booking flow", () => {
  it("offers other times only for services that may need approval, and never the chosen time or another person's", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { slots: [...asha, mira] } })));
    renderFlow(approvalAlways);

    await reachDetails(user);
    expect(screen.getByText("If we need to approve your booking, we can offer you any of these times instead.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Choose other times/ }));
    const popup = await screen.findByRole("dialog");
    expect(within(popup).getAllByRole("checkbox")).toHaveLength(asha.length - 1);
    expect(within(popup).queryByRole("checkbox", { name: /9:30/ })).not.toBeInTheDocument();
    expect(within(popup).queryByRole("checkbox", { name: /11:00 am/ })).not.toBeInTheDocument();
  });

  it("does not show the control for a service that never needs approval", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { slots: [...asha, mira] } })));
    renderFlow({ ...approvalAlways, rule: "never" });

    await reachDetails(user);
    expect(screen.queryByText(/These also work for me/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Choose other times/ })).not.toBeInTheDocument();
  });

  it("sends the ticked times as proposedStarts", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/public/availability?")) return jsonResponse({ data: { slots: asha } });
      if (String(input) === "/api/public/appointments" && init?.method === "POST") {
        return jsonResponse({ data: { appointmentId: "a1", manageToken: "tok-requested-1234567", status: "requested", startsAt: asha[0].startsAt, endsAt: asha[0].endsAt } }, 201);
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderFlow(approvalAlways);

    await reachDetails(user);
    await user.click(screen.getByRole("button", { name: /Choose other times/ }));
    const popup = await screen.findByRole("dialog");
    await user.click(within(popup).getByRole("checkbox", { name: /2:30/ }));
    expect(screen.getByRole("button", { name: /1 other time chosen/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.type(screen.getByRole("textbox", { name: "Full name" }), "Ananya Rao");
    await user.type(screen.getByRole("textbox", { name: "Mobile number" }), "+91 98450 12345");
    await user.type(screen.getByRole("textbox", { name: "Email address" }), "ananya@example.com");
    await user.click(screen.getByRole("checkbox", { name: /I understand and agree to this use of the booking details/i }));
    await user.click(screen.getByRole("button", { name: "Confirm booking" }));

    expect(await screen.findByRole("heading", { name: "Your request is waiting for approval" })).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([input]) => String(input) === "/api/public/appointments");
    const body = JSON.parse(String((post?.[1] as RequestInit).body));
    expect(body.proposedStarts).toEqual([asha.find((slot) => slot.startsAt.includes("T14:30"))!.startsAt]);
    expect(publicBookingSchema.safeParse(body).success).toBe(true);
  });
});

describe("confirmation for a request", () => {
  const success = { appointmentId: "a1", manageToken: "tok-requested-1234567", status: "requested" as const, startsAt: asha[0].startsAt, endsAt: asha[0].endsAt, previewMode: false };
  function confirmation(approval: ApprovalSettings) {
    renderWithAdapter(
        <BookingConfirmation
          success={success}
          clinic={demoClinic}
          location={demoLocations[0]}
          service={{ ...demoServices[0], approval }}
          preferredChannel="email"
        />,
    );
  }

  it("hides the address and says what happens next when the service hides it until approved", () => {
    confirmation({ ...approvalAlways, hideLocationUntilConfirmed: true });
    expect(screen.getByRole("heading", { name: "Your request is waiting for approval" })).toBeInTheDocument();
    expect(screen.getByText(/replies by email or message/)).toBeInTheDocument();
    expect(screen.getByText("We will send the address once your booking is confirmed.")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(demoLocations[0].address))).not.toBeInTheDocument();
  });

  it("shows the address when the service does not hide it", () => {
    confirmation(approvalAlways);
    expect(screen.getByText(new RegExp(demoLocations[0].address))).toBeInTheDocument();
  });
});

describe("manage page for a request that is not booked", () => {
  function snapshot(extra: Partial<ManageBookingSnapshot> & { status: ManageBookingSnapshot["appointment"]["status"] }): ManageBookingSnapshot {
    const { status, ...rest } = extra;
    const appointment = demoAppointments.find((item) => item.manageToken === "demo-booking")!;
    return {
      appointment: { ...appointment, status, version: 2 },
      clinic: demoClinic,
      location: demoLocations.find((item) => item.id === appointment.locationId)!,
      practitioner: demoPractitioners.find((item) => item.id === appointment.practitionerId)!,
      service: demoServices.find((item) => item.id === appointment.serviceId)!,
      canCancel: true,
      canReschedule: true,
      ...rest,
    };
  }
  function show(value: ManageBookingSnapshot) {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: value })));
    renderWithAdapter(
        <ManageBooking token="demo-booking" initialSnapshot={value} fallbackSlots={demoSlots} />,
    );
  }

  it("shows a waiting card with the offered times, no address, and keeps cancel", () => {
    show(snapshot({
      status: "requested",
      locationHidden: true,
      proposedStarts: ["2026-09-03T10:00:00+05:30"],
      location: { ...demoLocations[0], name: "", address: "", city: "" },
    }));
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.getByText("Also offered")).toBeInTheDocument();
    expect(screen.getByText(/3 September 2026 at 10:00/)).toBeInTheDocument();
    expect(screen.getByText("We will send the address once your booking is confirmed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument();
  });

  it("explains a decline with the reason and links back to the booking page, without cancel or change buttons", () => {
    show(snapshot({ status: "declined", declineReason: "fully_booked" }));
    expect(screen.getByText(`${demoClinic.name} could not take this request. We are fully booked.`)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Book another time" })).toHaveAttribute("href", `/book/${demoClinic.slug}`);
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change time" })).not.toBeInTheDocument();
  });

  it("says an expired request closed and links back to the booking page", () => {
    show(snapshot({ status: "expired" }));
    expect(screen.getByText("Nobody answered before the start time, so this request has closed.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Book another time" })).toHaveAttribute("href", `/book/${demoClinic.slug}`);
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
  });
});
