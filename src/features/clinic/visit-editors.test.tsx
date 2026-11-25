/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Appointment } from "@/lib/domain";
import { demoAppointments } from "@/lib/demo-data";

import { VisitPractitionerField, VisitServiceField, VisitSourceField } from "./visit-editors";

// jsdom under this Node version has no localStorage, and the property layout preview lives there.
const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
    clear: () => stored.clear(),
  },
});

afterEach(() => { cleanup(); window.sessionStorage.clear(); window.localStorage.clear(); });

const staffBooked = demoAppointments.find((item) => item.id === "apt_sneha_filling")!;
const onlineBooked = demoAppointments.find((item) => item.bookingSource === "online")!;

function saved(id: string): Appointment | undefined {
  const all = JSON.parse(window.sessionStorage.getItem("kalendr-preview-appointments-v1") ?? "[]") as Appointment[];
  return all.find((item) => item.id === id);
}

describe("editing a visit in place", () => {
  it("corrects how staff took the booking", async () => {
    const user = userEvent.setup();
    render(<VisitSourceField appointment={staffBooked} />);
    await user.click(screen.getByRole("combobox", { name: /^Booked via:/ }));
    await user.click(await screen.findByRole("option", { name: /Phone/ }));
    await waitFor(() => expect(saved(staffBooked.id)?.bookingSource).toBe("phone"));
  });

  it("leaves an online booking's source as it happened", () => {
    render(<VisitSourceField appointment={onlineBooked} />);
    expect(screen.queryByRole("combobox", { name: /^Booked via:/ })).not.toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("offers the people and services that fit the visit", async () => {
    const user = userEvent.setup();
    render(<><VisitPractitionerField appointment={staffBooked} label="Dentist" /><VisitServiceField appointment={staffBooked} /></>);
    await user.click(screen.getByRole("combobox", { name: /^Dentist:/ }));
    expect((await screen.findAllByRole("option")).length).toBeGreaterThan(0);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("combobox", { name: /^Service:/ }));
    expect((await screen.findAllByRole("option")).length).toBeGreaterThan(0);
  });
});
