/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoPatients } from "@/lib/demo-data";
import { TestQueryProvider } from "@/test/query-wrapper";

import { PatientDetailsDialog, type PatientVisitEntry } from "./patient-details-dialog";

afterEach(cleanup);

const patient = { ...demoPatients[0], phone: "98450 12345" };
const visits: PatientVisitEntry[] = [
  { id: "v2", startsAt: "2026-08-31T11:00:00+05:30", status: "booked", title: "Routine cleaning", detail: "Mira Sen" },
  { id: "v1", startsAt: "2026-05-12T10:00:00+05:30", status: "completed", title: "Dental X-ray", detail: "Mira Sen" },
];

function open(props: Partial<React.ComponentProps<typeof PatientDetailsDialog>> = {}) {
  return render(<TestQueryProvider><PatientDetailsDialog open onOpenChange={vi.fn()} patient={patient} patients={[patient]} onSaved={vi.fn()} {...props} /></TestQueryProvider>);
}

describe("PatientDetailsDialog", () => {
  it("shows the visit history as a timeline when editing", () => {
    open({ visits });
    const history = screen.getByRole("region", { name: "Visit history" });
    expect(within(history).getByText("Routine cleaning")).toBeInTheDocument();
    expect(within(history).getByText("Dental X-ray")).toBeInTheDocument();
    expect(history.querySelectorAll("[data-slot=timeline-item]")).toHaveLength(2);
  });

  it("leaves the timeline out when adding a new person", () => {
    open({ patient: undefined, visits });
    expect(screen.queryByRole("region", { name: "Visit history" })).not.toBeInTheDocument();
  });

  it("reads the stored phone into the international phone field", async () => {
    open({ visits });
    // The phone picker loads on demand, so wait for it rather than its placeholder.
    expect(await screen.findByRole("textbox", { name: "Phone" })).toHaveValue("+91 98450 12345");
  });
});
