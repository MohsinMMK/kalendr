/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";

import { AppointmentTask } from "./appointment-task";
import { chooseOption, runBarAction } from "@/test/choose-option";
import { TestQueryProvider } from "@/test/query-wrapper";
import { DashboardWorkspace } from "./dashboard-workspace";
import { NotificationBell } from "./notification-bell";
import { ScheduleWorkspace } from "./schedule-workspace";
import { NewAppointmentTask } from "./new-appointment-task";
import { appointmentHasConflict, compatibleSlots, previewClockStart, usePreviewAppointments, visitStartConflict } from "./preview-appointments";
import { matchingPatientContacts, searchPatients } from "./patient-directory";
import { PatientsWorkspace } from "./patients-workspace";
import { NewVisitProvider } from "./new-visit-sheet";
import { demoAppointments, demoClinic, demoPatients, demoServices } from "@/lib/demo-data";
import type { Appointment, Patient } from "@/lib/domain";

// jsdom under this Node version has no localStorage, and the Today panel choice lives there.
const storedPanels = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storedPanels.get(key) ?? null,
    setItem: (key: string, value: string) => void storedPanels.set(key, value),
    removeItem: (key: string) => void storedPanels.delete(key),
    clear: () => storedPanels.clear(),
  },
});

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(() => { cleanup(); window.sessionStorage.clear(); window.localStorage.clear(); window.history.replaceState({}, "", "/"); });

function savedAppointments(): Appointment[] {
  return JSON.parse(window.sessionStorage.getItem("kalendr-preview-appointments-v1") ?? "[]") as Appointment[];
}

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/dashboard" }));

/** A visit's card on the board; its name says who, when and what. */
function card(name: string | RegExp, list?: HTMLElement) {
  const pattern = typeof name === "string" ? new RegExp(name) : name;
  return (list ? within(list) : screen).getByRole("button", { name: pattern });
}

/** Opens a visit's details beside the board. */
async function openCard(user: ReturnType<typeof userEvent.setup>, name: string, list?: HTMLElement) {
  await user.click(card(name, list));
  return screen.findByRole("complementary", { name });
}

/** Today as staff see it: the page, plus the header's notifications bell. */
function Today() {
  return (
    <>
      <TestQueryProvider><NotificationBell preview /></TestQueryProvider>
      <DashboardWorkspace />
    </>
  );
}

describe("staff patient flow", () => {
  it("lays the queue out in the order a visit moves and offers one next step per visit", async () => {
    render(<Today />);
    const titles = ["Up next", "Waiting", "With practitioner", "Done"];
    const sections = titles.map((name) => screen.getByRole("group", { name }));
    // Left to right is the order a visit moves through the day.
    sections.slice(1).forEach((section, index) => expect(sections[index].compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
    const user = userEvent.setup();
    const upNext = screen.getByRole("list", { name: "Up next visits" });
    // The card opens its details beside the board, with the one next step first.
    const details = await openCard(user, "Ananya Rao", upNext);
    expect(within(details).getByRole("link", { name: "Check in · Ananya Rao" })).toHaveAttribute("href", "/appointments/apt_ananya_arriving?from=dashboard&action=checkin");
    expect(within(details).getByRole("link", { name: /Open full visit/ })).toHaveAttribute("href", expect.stringContaining("/appointments/apt_ananya_arriving"));
    await user.click(within(details).getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Ananya Rao" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Notifications: 3 need attention" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Notifications/ }));
    expect(await screen.findByRole("region", { name: "Needs attention" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole("button", { name: "View" })).not.toBeInTheDocument();
  });

  it("filters Today by patient, practitioner and room without changing appointment data", async () => {
    const user = userEvent.setup();
    render(<DashboardWorkspace />);
    expect(screen.getByRole("heading", { level: 1, name: "Patient queue" })).toBeInTheDocument();
    const cards = () => [...document.querySelectorAll<HTMLElement>("[data-card-id]")];
    expect(cards()).toHaveLength(5);
    await user.type(screen.getByRole("searchbox", { name: "Search today's patients" }), "Ananya");
    // Hidden cards fade out before they leave the page.
    await waitFor(() => expect(cards().map((item) => item.textContent)).toEqual([expect.stringContaining("Ananya Rao")]));
    await user.click(screen.getByRole("button", { name: "Room" }));
    await user.click(await screen.findByRole("checkbox", { name: /^Operatory 1/ }));
    await waitFor(() => expect(cards()).toHaveLength(0));
    expect(screen.getByRole("button", { name: "Room, 1 selected" })).toBeInTheDocument();
    expect(screen.getByText("No more bookings")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("kalendr-preview-appointments-v1")).toBeNull();
  });

  it("moves a reviewed visit through checked in, in appointment and completed with unique audit IDs", async () => {
    const user = userEvent.setup();
    render(<AppointmentTask appointmentId="apt_ananya_arriving" initialAction="checkin" />);
    await user.click(screen.getByRole("button", { name: "Confirm check in patient" }));
    expect(savedAppointments().find((item) => item.id === "apt_ananya_arriving")?.status).toBe("checked_in");
    const operations = JSON.parse(window.sessionStorage.getItem("kalendr-preview-operations-v1") ?? "{}") as { visitTimings: Record<string, { checkedInAt?: string }> };
    expect(operations.visitTimings.apt_ananya_arriving.checkedInAt).toBe(previewClockStart);
    cleanup();

    render(<AppointmentTask appointmentId="apt_ananya_arriving" initialAction="start" />);
    await waitFor(() => expect(screen.getAllByText("Checked in").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "Confirm start appointment" }));
    expect(screen.getByRole("status")).toHaveTextContent("In appointment");
    cleanup();

    render(<DashboardWorkspace />);
    await waitFor(() => expect(card("Ananya Rao", screen.getByRole("list", { name: "With practitioner visits" }))).toBeInTheDocument());
    cleanup();

    render(<AppointmentTask appointmentId="apt_ananya_arriving" initialAction="complete" />);
    await waitFor(() => expect(screen.getAllByText("In appointment").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "Confirm complete appointment" }));
    expect(savedAppointments().find((item) => item.id === "apt_ananya_arriving")?.status).toBe("completed");
    const audit = JSON.parse(window.sessionStorage.getItem("kalendr-preview-audit-v1") ?? "[]") as { id: string; action: string }[];
    expect(new Set(audit.map((item) => item.id)).size).toBe(audit.length);
    cleanup();
    render(<DashboardWorkspace />);
    await waitFor(() => expect(card("Ananya Rao", screen.getByRole("list", { name: "Done visits" }))).toBeInTheDocument());
  });

  it("ranks a derived long wait first and persists owner and handover notes", async () => {
    const user = userEvent.setup();
    render(<AppointmentTask appointmentId="apt_ananya_arriving" initialAction="checkin" />);
    await user.click(screen.getByRole("button", { name: "Confirm check in patient" }));
    cleanup();
    render(<Today />);
    await waitFor(() => expect(card(/Ananya Rao.*Waiting 0 min/)).toBeInTheDocument());
    await runBarAction(user, /^Advance 15 min/);
    await user.click(screen.getByRole("button", { name: /^Notifications/ }));
    const priorities = await screen.findByRole("region", { name: "Needs attention" });
    expect(within(priorities).getAllByRole("heading", { level: 3 })[0]).toHaveTextContent("Long wait");
    await chooseOption(user, screen.getByRole("combobox", { name: "Owner for long wait for Ananya Rao" }), "Reception");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs attention" })).not.toBeInTheDocument());
    await runBarAction(user, /^Handover/);
    await user.click(await screen.findByRole("button", { name: "Add note" }));
    await user.type(screen.getByRole("textbox", { name: "Scheduling note" }), "Hygiene bay ready after noon.");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    cleanup();
    render(<Today />);
    await runBarAction(user, /^Handover/);
    expect(await screen.findByText("Hygiene bay ready after noon.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /^Notifications/ }));
    expect(await screen.findByRole("combobox", { name: "Owner for long wait for Ananya Rao" })).toHaveTextContent("Reception");
  });

  it("reviews form receipt before removing its priority", async () => {
    const user = userEvent.setup();
    render(<AppointmentTask appointmentId="apt_sneha_filling" initialAction="form_received" />);
    expect(screen.getByText(/No form content or clinical record is uploaded/)).toBeInTheDocument();
    expect(window.sessionStorage.getItem("kalendr-preview-appointments-v1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm mark form received" }));
    expect(savedAppointments().find((item) => item.id === "apt_sneha_filling")?.formStatus).toBe("submitted");
    cleanup();
    render(<TestQueryProvider><NotificationBell preview /></TestQueryProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications: 2 need attention" })).toBeInTheDocument());
  });

  it("keeps an existing-patient draft on Back, creates a same-day appointment and blocks the occupied slot", async () => {
    const user = userEvent.setup();
    render(<NewAppointmentTask />);
    await user.click(screen.getByRole("button", { name: /Ananya Rao/ }));
    await user.click(screen.getByRole("button", { name: /Choose service and time/ }));
    await user.click(screen.getByRole("combobox", { name: "Service" }));
    await screen.findByRole("option", { name: /Routine cleaning/ });
    expect(screen.queryByRole("option", { name: /New patient consultation/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Routine cleaning/ }));
    await user.click(screen.getByRole("button", { name: "List" }));
    await user.click(screen.getByRole("button", { name: /Mon, 31 Aug, 12:00 pm.*Mira Sen.*Hygiene bay/ }));
    await user.click(screen.getByRole("button", { name: "Back to patient" }));
    expect(screen.getByRole("button", { name: /Ananya Rao/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: /Choose service and time/ }));
    expect(screen.getByRole("button", { name: /Mon, 31 Aug, 12:00 pm.*Mira Sen.*Hygiene bay/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Review appointment" }));
    expect(window.sessionStorage.getItem("kalendr-preview-appointments-v1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm appointment" }));
    expect(savedAppointments()).toHaveLength(demoAppointments.length + 1);
    const added = savedAppointments().find((item) => item.id.startsWith("apt_preview_"))!;
    expect(added.startsAt).toBe("2026-08-31T12:00:00+05:30");
    const cleaning = demoServices.find((item) => item.id === "service_cleaning")!;
    expect(compatibleSlots({ service: cleaning, locationId: "loc_indiranagar", patientId: "patient_ananya", appointments: savedAppointments() }).some((opening) => opening.id === "staff_2026_08_31_1200_mira")).toBe(false);
    cleanup();
    render(<TestQueryProvider><NuqsTestingAdapter searchParams="?view=agenda"><ScheduleWorkspace /></NuqsTestingAdapter></TestQueryProvider>);
    // An older link to the agenda opens the list, where the new visit shows with its time and who it is for.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Ananya Rao/ }).some((row) => /12:00 pm/.test(row.textContent ?? "") && /45 min/.test(row.textContent ?? ""))).toBe(true), { timeout: 3000 });
  });

  it("accepts a new patient without email for phone contact and preserves service rules", async () => {
    const user = userEvent.setup();
    render(<NewAppointmentTask />);
    await user.click(screen.getByRole("button", { name: "New patient" }));
    await user.type(screen.getByRole("textbox", { name: "First name" }), "Leela");
    await user.type(screen.getByRole("textbox", { name: "Last name" }), "Nair");
    await user.type(screen.getByRole("textbox", { name: "Phone" }), "9876543210");
    await user.click(screen.getByRole("button", { name: /Choose service and time/ }));
    await user.click(screen.getByRole("combobox", { name: "Service" }));
    await screen.findByRole("option", { name: /New patient consultation/ });
    expect(screen.queryByRole("option", { name: /Filling review/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /New patient consultation/ }));
    await user.click(screen.getByRole("button", { name: "List" }));
    await user.click(screen.getByRole("button", { name: /Mon, 31 Aug, 11:30 am.*Dr. Asha Mehta.*Operatory 1/ }));
    await user.click(screen.getByRole("button", { name: "Review appointment" }));
    await user.click(screen.getByRole("button", { name: "Confirm appointment" }));
    const patients = JSON.parse(window.sessionStorage.getItem("kalendr-preview-patients-v1") ?? "[]") as Patient[];
    const leela = patients.find((patient) => patient.firstName === "Leela");
    expect(leela?.email).toBe("");
    expect(leela?.id).toMatch(/^patient_preview_/);
    cleanup();
    render(<TestQueryProvider><PatientsWorkspace /></TestQueryProvider>);
    await waitFor(() => expect(screen.getByRole("table")).toHaveTextContent("Leela Nair"));
    await user.type(screen.getByRole("searchbox", { name: "Search patients" }), "Leela");
    expect(screen.getByRole("table")).toHaveTextContent("Leela Nair");
    expect(screen.getByRole("table")).not.toHaveTextContent(leela!.id);
  });

  it("searches the shared patient identity and suggests exact contact matches", async () => {
    const user = userEvent.setup();
    render(<NewAppointmentTask />);
    await user.type(screen.getByRole("searchbox", { name: "Search patients" }), "9845012345");
    expect(screen.getAllByRole("button", { name: /Ananya Rao/ })).toHaveLength(1);
    await chooseOption(user, screen.getByRole("combobox", { name: "Search in" }), "Email");
    expect(screen.getByText(/No patients match/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await user.type(screen.getByRole("searchbox", { name: "Search patients" }), "priya.patel");
    await user.click(screen.getByRole("button", { name: /Priya Patel/ }));
    expect(screen.getByRole("status")).toHaveTextContent("Selected: Priya Patel");
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Priya Patel/ }));
    await user.click(screen.getByRole("button", { name: "New patient" }));
    await user.type(screen.getByRole("textbox", { name: "Phone" }), "98450 12345");
    expect(screen.getByText("Possible existing patient")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use existing patient" }));
    expect(screen.getByRole("status")).toHaveTextContent("Selected: Ananya Rao");
  });

  it("matches name, ID, phone and email without dropping punctuation-sensitive phone searches", () => {
    expect(searchPatients(demoPatients, "rao", "name").map((patient) => patient.id)).toEqual(["patient_ananya", "patient_sneha", "patient_kabir"]);
    expect(searchPatients(demoPatients, "PATIENT_ANKIT", "id").map((patient) => patient.id)).toEqual(["patient_ankit"]);
    expect(searchPatients(demoPatients, "98450 12345", "phone").map((patient) => patient.id)).toEqual(["patient_ananya"]);
    expect(searchPatients(demoPatients, "PRIYA.PATEL@EXAMPLE.COM", "email").map((patient) => patient.id)).toEqual(["patient_priya"]);
    expect(searchPatients(demoPatients, "patient_preview_6")).toEqual([]);
    expect(matchingPatientContacts(demoPatients, "98450 12345", "").map((patient) => patient.id)).toEqual(["patient_ananya"]);
    expect(matchingPatientContacts(demoPatients, "", "")).toEqual([]);
  });

  it("rolls back a new appointment if its shared patient record cannot be saved", () => {
    const { result } = renderHook(() => usePreviewAppointments());
    const patient: Patient = { ...demoPatients[0], id: "patient_preview_failure", clinicId: demoClinic.id };
    const appointment: Appointment = { ...demoAppointments[0], id: "apt_preview_failure", patientId: patient.id, serviceId: "service_consultation", practitionerId: "practitioner_asha", resourceIds: ["resource_op1"], startsAt: "2026-08-31T11:30:00+05:30", endsAt: "2026-08-31T12:15:00+05:30" };
    // Spy on jsdom's own prototype: on recent Node versions the global Storage is a different class.
    const storagePrototype = Object.getPrototypeOf(window.sessionStorage) as Storage;
    const originalSetItem = storagePrototype.setItem;
    const saveSpy = vi.spyOn(storagePrototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === "kalendr-preview-patients-v1") throw new DOMException("Storage unavailable", "QuotaExceededError");
      originalSetItem.call(this, key, value);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      act(() => expect(result.current.addAppointment(appointment, patient)).toBe(false));
      expect(window.sessionStorage.getItem("kalendr-preview-appointments-v1")).toBeNull();
      expect(window.sessionStorage.getItem("kalendr-preview-patients-v1")).toBeNull();
      expect(result.current.appointments).toHaveLength(demoAppointments.length);
      expect(result.current.patients).toHaveLength(demoPatients.length);
    } finally {
      saveSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("rejects resource, practitioner and patient conflicts before offering or starting", () => {
    const cleaning = demoServices.find((service) => service.id === "service_cleaning")!;
    const consultation = demoServices.find((service) => service.id === "service_consultation")!;
    expect(compatibleSlots({ service: consultation, locationId: "loc_indiranagar", appointments: demoAppointments }).every((slot) => slot.resourceId !== "resource_hygiene")).toBe(true);
    const conflict: Appointment = { ...demoAppointments[0], id: "other", patientId: "patient_priya", practitionerId: "practitioner_mira", resourceIds: ["resource_op2"] };
    expect(appointmentHasConflict(conflict, demoAppointments)).toBe(true);
    expect(visitStartConflict(demoAppointments[0], demoAppointments, {}, previewClockStart)?.id).toBe("apt_ankit_request");
    expect(compatibleSlots({ service: cleaning, locationId: "loc_indiranagar", appointments: demoAppointments }).some((slot) => slot.id === "staff_2026_08_31_1200_mira")).toBe(true);
  });
});

describe("today's token queue", () => {
  function savedQueue() {
    return JSON.parse(window.sessionStorage.getItem("kalendr-preview-operations-v1") ?? "{}") as { queueTickets?: Record<string, { number: number; calledAt?: string; urgent: boolean }> };
  }

  async function addWalkIn(user: ReturnType<typeof userEvent.setup>, firstName: string, phone: string) {
    // Walk-ins go through New appointment, opened in Walk-in mode from the Waiting column.
    await user.click(screen.getAllByRole("button", { name: "Add walk-in" })[0]);
    const sheet = await screen.findByRole("dialog", { name: "Add walk-in" });
    await user.click(within(sheet).getByRole("button", { name: /^New / }));
    await user.type(within(sheet).getByRole("textbox", { name: "First name" }), firstName);
    await user.type(within(sheet).getByRole("textbox", { name: "Phone" }), phone);
    await user.click(within(sheet).getByRole("combobox", { name: /^Service:/ }));
    await user.click((await screen.findAllByRole("option"))[0]);
    await user.click(within(sheet).getByRole("button", { name: "Check in" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add walk-in" })).not.toBeInTheDocument());
  }

  /** Today with the New appointment sheet mounted, as in the staff app. */
  const Desk = () => <NewVisitProvider><DashboardWorkspace /></NewVisitProvider>;

  it("adds a walk-in with a first name and phone, checks them in and gives them a token", async () => {
    const user = userEvent.setup();
    render(<Desk />);
    await addWalkIn(user, "Meera", "98200 11122");
    const added = savedAppointments().find((item) => item.bookingSource === "walk_in");
    expect(added?.status).toBe("checked_in");
    expect(savedQueue().queueTickets?.[added!.id]?.number).toBe(1);
    const waiting = screen.getByRole("list", { name: "Waiting visits" });
    expect(card(/^Token 1, Meera/, waiting)).toBeInTheDocument();
  });

  it("calls the next token, then marks another urgent with a reason", async () => {
    const user = userEvent.setup();
    render(<Desk />);
    await addWalkIn(user, "Meera", "98200 11122");
    await addWalkIn(user, "Kabir", "98200 33344");
    const [first, second] = savedAppointments().filter((item) => item.bookingSource === "walk_in");

    await runBarAction(user, /^Call next/);
    await waitFor(() => expect(savedQueue().queueTickets?.[first.id]?.calledAt).toBeTruthy());
    expect(savedQueue().queueTickets?.[second.id]?.calledAt).toBeUndefined();

    const kabir = await openCard(user, "Kabir", screen.getByRole("list", { name: "Waiting visits" }));
    await user.click(within(kabir).getByRole("button", { name: "More for Kabir" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark urgent…" }));
    const dialog = await screen.findByRole("dialog", { name: "Mark #2 urgent" });
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Severe pain");
    await user.click(within(dialog).getByRole("button", { name: "Mark urgent" }));
    await waitFor(() => expect(savedQueue().queueTickets?.[second.id]?.urgent).toBe(true));
    expect(within(screen.getByRole("list", { name: "Waiting visits" })).getByText("Urgent")).toBeInTheDocument();
  });

  it("tells one waiting customer it is their turn, then tells everyone still to be seen that it is running late", async () => {
    const savedMessages = () => (JSON.parse(window.sessionStorage.getItem("kalendr-preview-operations-v1") ?? "{}") as { messages?: { appointmentId: string; templateKey: string }[] }).messages ?? [];
    const user = userEvent.setup();
    render(<Desk />);
    await addWalkIn(user, "Meera", "98200 11122");
    const [walkIn] = savedAppointments().filter((item) => item.bookingSource === "walk_in");

    const meera = await openCard(user, "Meera", screen.getByRole("list", { name: "Waiting visits" }));
    await user.click(within(meera).getByRole("button", { name: "More for Meera" }));
    await user.click(await screen.findByRole("menuitem", { name: "Send message" }));
    await user.click(await screen.findByRole("menuitem", { name: "It's your turn" }));
    await waitFor(() => expect(savedMessages()).toContainEqual(expect.objectContaining({ appointmentId: walkIn.id, templateKey: "appointment.quick_message.your_turn" })));

    await runBarAction(user, /^Running late/);
    const dialog = await screen.findByRole("dialog", { name: "Running late" });
    expect(within(dialog).getByText(/running about 15 minutes late/)).toBeInTheDocument();
    const send = within(dialog).getByRole("button", { name: /^Tell \d+/ });
    const told = Number(/\d+/.exec(send.textContent ?? "")?.[0]);
    await user.click(send);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Running late" })).not.toBeInTheDocument());
    expect(savedMessages().filter((item) => item.templateKey === "appointment.quick_message.running_late")).toHaveLength(told);
  });

});
