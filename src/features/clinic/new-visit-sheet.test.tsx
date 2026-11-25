/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Appointment } from "@/lib/domain";

import { NewVisitProvider, useNewVisit, type NewVisitPrefill } from "./new-visit-sheet";

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

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/dashboard" }));

afterEach(() => { cleanup(); push.mockClear(); window.sessionStorage.clear(); window.localStorage.clear(); });

function savedAppointments(): Appointment[] {
  return JSON.parse(window.sessionStorage.getItem("kalendr-preview-appointments-v1") ?? "[]") as Appointment[];
}

function Opener({ prefill }: { prefill?: NewVisitPrefill }) {
  const { openNewVisit } = useNewVisit();
  return <button type="button" onClick={() => openNewVisit(prefill)}>Open booking</button>;
}

describe("booking in the side sheet", () => {
  it("books an existing customer from the sheet and keeps the visit's own properties", async () => {
    const user = userEvent.setup();
    render(<NewVisitProvider><Opener /></NewVisitProvider>);
    await user.click(screen.getByRole("button", { name: "Open booking" }));
    const sheet = await screen.findByRole("dialog");

    await user.type(within(sheet).getByRole("searchbox", { name: /Find a/ }), "Ananya");
    await user.click(within(sheet).getByRole("button", { name: /Ananya Rao/ }));

    await user.click(within(sheet).getByRole("combobox", { name: /^Service:/ }));
    await user.click((await screen.findAllByRole("option"))[0]);
    await user.click(within(sheet).getByRole("combobox", { name: /^Time:/ }));
    const times = await screen.findAllByRole("option");
    expect(times.length).toBeGreaterThan(0);
    await user.click(times[0]);
    await user.type(within(sheet).getByRole("textbox", { name: "Reason" }), "Follow-up check");

    await user.click(within(sheet).getByRole("button", { name: /^Book/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const created = savedAppointments().find((item) => item.id.startsWith("apt_preview_"));
    expect(created).toMatchObject({ reasonForVisit: "Follow-up check", status: "booked", bookingSource: "staff" });
  });

  it("asks for what is missing instead of booking", async () => {
    const user = userEvent.setup();
    render(<NewVisitProvider><Opener /></NewVisitProvider>);
    await user.click(screen.getByRole("button", { name: "Open booking" }));
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: /^Book/ }));
    expect(within(sheet).getByText(/^Choose a .*, or add a new one\./)).toBeInTheDocument();
    expect(savedAppointments().some((item) => item.id.startsWith("apt_preview_"))).toBe(false);
  });

  it("starts with the customer it was opened for", async () => {
    const user = userEvent.setup();
    render(<NewVisitProvider><Opener prefill={{ patientId: "patient_ananya" }} /></NewVisitProvider>);
    await user.click(screen.getByRole("button", { name: "Open booking" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Ananya Rao")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Change" })).toBeInTheDocument();
  });

  it("falls back to the booking page where the sheet isn't mounted", async () => {
    const user = userEvent.setup();
    render(<Opener prefill={{ patientId: "patient_ananya", date: "2026-08-31" }} />);
    await user.click(screen.getByRole("button", { name: "Open booking" }));
    expect(push).toHaveBeenCalledWith("/appointments/new?patient=patient_ananya&date=2026-08-31");
  });
});
