/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppointmentRoutingView } from "@/lib/routing-forms";

import { AppointmentRoutingCard } from "./appointment-routing-card";

const access = { can: (permission: string) => permission.length > 0 };
vi.mock("@/features/clinic/staff-access", () => ({ useStaffAccess: () => access }));
vi.mock("@/features/clinic/clinic-catalog", () => ({
  useCatalogLookups: () => ({ practitioners: [{ id: "p1", name: "Dr Iyer" }, { id: "p2", name: "Dr Rao" }] }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  access.can = () => true;
});

const view: AppointmentRoutingView = {
  formName: "Find the right service",
  routeName: "Tamil speakers",
  routedAt: "2026-11-20T10:00:00Z",
  summary: "Routed by: Language includes Tamil. Dr Iyer had the fewest bookings this month.",
  trace: {
    matchedRouteId: "r1",
    matchedRouteName: "Tamil speakers",
    routes: [
      { routeId: "r0", name: "Children", matched: false, conditions: [{ fieldId: "q1", label: "Age", operator: "equals", expected: "Under 12", passed: false }] },
      { routeId: "r1", name: "Tamil speakers", matched: true, conditions: [{ fieldId: "q2", label: "Language", operator: "contains", expected: "Tamil", passed: true }] },
    ],
    people: [
      { personId: "p1", name: "Dr Iyer", passed: true, reasons: ["Language includes Tamil"], multiplier: 1 },
      { personId: "p2", name: "Dr Rao", passed: false, reasons: ["Language does not include Tamil"], multiplier: 1 },
    ],
  },
};

const response = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

function renderCard() {
  return render(<AppointmentRoutingCard appointmentId="appt_1" />);
}

describe("AppointmentRoutingCard", () => {
  it("renders nothing for a booking that was not routed", async () => {
    const fetchMock = vi.fn(async () => response({ data: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderCard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String((fetchMock.mock.calls as unknown[][])[0]?.[0])).toBe("/api/staff/routing-forms/appointment/appt_1");
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the summary and the trace of a routed booking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ data: view })));
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByText(view.summary)).toBeInTheDocument();
    expect(screen.getByText(/Find the right service/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /See how this was decided/ }));
    expect(await screen.findByText("Age is Under 12")).toBeInTheDocument();
    expect(screen.getByText("Language includes Tamil", { selector: "li > span" })).toBeInTheDocument();
    expect(screen.getByText("did not match")).toBeInTheDocument();
    expect(screen.getByText(/Dr Rao/)).toBeInTheDocument();
  });

  it("hides the flag action without the permission", async () => {
    access.can = () => false;
    vi.stubGlobal("fetch", vi.fn(async () => response({ data: view })));
    renderCard();
    await screen.findByText(view.summary);
    expect(screen.queryByRole("button", { name: "This should have gone to someone else" })).not.toBeInTheDocument();
  });

  it("posts the wrong assignment from the dialog", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => (init?.method === "POST" ? response({ data: { id: "w1" } }, 201) : response({ data: view })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "This should have gone to someone else" }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Dr Rao" }));
    await user.type(screen.getByRole("textbox", { name: /Note/ }), "Customer asked for Dr Rao");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post).toBeTruthy();
      expect(String(post?.[0])).toBe("/api/staff/routing-forms/wrong-assignments");
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ appointmentId: "appt_1", correctPractitionerId: "p2", note: "Customer asked for Dr Rao" });
    });
  });
});
