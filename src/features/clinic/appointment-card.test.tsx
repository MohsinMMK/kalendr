/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { demoAppointments, demoPatients } from "@/lib/demo-data";

import { AppointmentPopover } from "./appointment-card";

afterEach(cleanup);

const booked = demoAppointments.find((item) => item.id === "apt_priya_cleaning")!;
const show = (appointment: typeof booked, clockIso = "2026-08-31T07:00:00+05:30") =>
  render(<AppointmentPopover appointment={appointment} anchor={document.body} patients={demoPatients} started={false} clockIso={clockIso} context="from=bookings" onClose={() => {}} />);

describe("AppointmentPopover", () => {
  it("shows who, when and the next steps for a booked visit, with nothing to flag", () => {
    show(booked);
    expect(screen.getByRole("heading", { name: "Priya Patel" })).toBeInTheDocument();
    const when = within(screen.getByRole("list", { name: "When" }));
    expect(when.getByText("Mon, 31 Aug")).toBeInTheDocument();
    expect(when.getByText(/8:30 am – 9:15 am/)).toBeInTheDocument();
    expect(when.getByText("45 min")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check in" })).toHaveAttribute("href", "/appointments/apt_priya_cleaning?from=bookings&action=checkin");
    expect(screen.getByRole("link", { name: "Reschedule" })).toHaveAttribute("href", "/appointments/apt_priya_cleaning?from=bookings&action=reschedule");
    expect(screen.getByRole("link", { name: "Details" })).toHaveAttribute("href", "/appointments/apt_priya_cleaning?from=bookings");
    expect(screen.queryByRole("list", { name: "Needs attention" })).not.toBeInTheDocument();
  });

  it("links the customer, service and person to their own pages", () => {
    show(booked);
    expect(screen.getByRole("link", { name: "Priya Patel" })).toHaveAttribute("href", `/patients?patient=${booked.patientId}`);
    const details = within(screen.getByRole("list", { name: /details$/ }));
    expect(details.getByRole("link", { name: /cleaning/i })).toHaveAttribute("href", `/services/${booked.serviceId}`);
    expect(details.getByRole("link", { name: /Dr/ })).toHaveAttribute("href", `/doctors?member=${booked.practitionerId}`);
  });

  it("asks for approval on a request and flags what is missing", () => {
    show({ ...booked, status: "requested", formStatus: "not_started", reminderStatus: "failed" });
    expect(screen.getByRole("link", { name: "Approve" })).toHaveAttribute("href", "/appointments/apt_priya_cleaning?from=bookings");
    expect(screen.getByRole("link", { name: "Suggest a time" })).toBeInTheDocument();
    const flags = within(screen.getByRole("list", { name: "Needs attention" }));
    expect(flags.getByText("Form not filled in yet")).toBeInTheDocument();
    expect(flags.getByText("Reminder failed to send")).toBeInTheDocument();
  });

  it("has no next step for a finished visit, only the way to its details", () => {
    show({ ...booked, status: "completed" });
    expect(screen.queryByRole("link", { name: "Check in" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Details" })).toBeInTheDocument();
  });
});
