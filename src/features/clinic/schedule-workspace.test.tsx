/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter, type OnUrlUpdateFunction } from "nuqs/adapters/testing";

import { demoAppointments, demoPatients } from "@/lib/demo-data";
import { chooseOption } from "@/test/choose-option";
import { TestQueryProvider } from "@/test/query-wrapper";

import { AppointmentTask } from "./appointment-task";
import type { ClinicCalendarProps, ClinicEvent } from "./clinic-calendar";
import { NewAppointmentTask } from "./new-appointment-task";
import { SchedulePlanningPanel } from "./schedule-planning";
import { defaultScheduleAvailability } from "./schedule-availability";
import { ScheduleWorkspace } from "./schedule-workspace";
import { StaffAccessProvider } from "./staff-access";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

// KLOQ lays itself out from measured sizes, which jsdom doesn't have. These tests cover what the schedule
// hands to it and does with its callbacks; KLOQ itself was exercised in a real browser.
const calendar: { props: ClinicCalendarProps } = { props: {} as ClinicCalendarProps };
vi.mock("./clinic-calendar", async (importOriginal) => ({
  ...await importOriginal<typeof import("./clinic-calendar")>(),
  ClinicCalendar: (props: ClinicCalendarProps) => { calendar.props = props; return <div>{props.children}</div>; },
}));
vi.mock("@/components/kloq", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/kloq")>(),
  KloqToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  KloqNav: () => null,
}));

beforeAll(() => {
  // The schedule asks whether it is on a phone; jsdom has no media queries.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(() => { cleanup(); push.mockClear(); window.sessionStorage.clear(); window.history.replaceState({}, "", "/"); });

/** The schedule with its address, as the browser would have it, and a way to read what it writes back. */
function renderSchedule(search: string) {
  const updates: URLSearchParams[] = [];
  const onUrlUpdate: OnUrlUpdateFunction = ({ searchParams }) => { updates.push(new URLSearchParams(searchParams)); };
  render(<TestQueryProvider><NuqsTestingAdapter searchParams={search} onUrlUpdate={onUrlUpdate}><ScheduleWorkspace /></NuqsTestingAdapter></TestQueryProvider>);
  return { updates, lastUrl: () => updates[updates.length - 1] };
}

describe("staff Schedule workflow", () => {
  it("shows a practitioner only their own column", () => {
    render(<TestQueryProvider><NuqsTestingAdapter searchParams="?date=2026-08-31&view=staff"><StaffAccessProvider role="practitioner" permissions={["schedule.read"]} userId="user_asha" ownPractitionerId="practitioner_asha"><ScheduleWorkspace /></StaffAccessProvider></NuqsTestingAdapter></TestQueryProvider>);
    expect(calendar.props.lanes?.map((lane) => lane.id)).toEqual(["practitioner_asha"]);
  });

  it("filters the calendar's visits by status and hides inactive ones until asked", async () => {
    const user = userEvent.setup();
    const page = renderSchedule("?date=2026-08-31&view=staff");
    expect(calendar.props.events?.some((event) => event.id === "apt_ankit_request")).toBe(true);
    expect(calendar.props.events?.find((event) => event.id === "apt_ankit_request")?.title).toMatch(/Ankit Kapoor · Needs approval/);
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await chooseOption(user, screen.getByRole("combobox", { name: "Appointment status" }), "Cancelled");
    expect(calendar.props.events?.filter((event) => (event as ClinicEvent).kind === "appointment")).toEqual([]);
    expect(page.lastUrl().get("status")).toBe("cancelled");
    expect(page.lastUrl().get("date")).toBe("2026-08-31");
  });

  it("turns to the day of a visit named in a link from another page, and opens its card only once it has somewhere to point", async () => {
    // Bookings links name the visit but not its day; an unanchored card would sit invisible and hold the page's focus.
    const page = renderSchedule("?open=apt_priya_cleaning&date=2026-09-02&view=staff");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(page.updates.some((url) => url.get("date") === "2026-08-31" && url.get("open") === "apt_priya_cleaning")).toBe(true));
  });

  it("opens free time with booking context and no mutation", async () => {
    renderSchedule("?date=2026-08-31&view=day");
    act(() => calendar.props.onOpenTime?.({ dateKey: "2026-08-31", minute: 12 * 60, practitionerId: "practitioner_mira" }));
    fireEvent.click(await screen.findByRole("button", { name: /Book this opening|Choose a time/ }));
    // Outside the workspace frame there is no booking sheet, so it falls back to the booking page with the same context.
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/appointments\/new\?.*date=2026-08-31.*location=loc_indiranagar/));
    expect(window.sessionStorage.getItem("kalendr-preview-appointments-v1")).toBeNull();
  });

  it("sends a dragged visit to review without changing it", () => {
    renderSchedule("?date=2026-08-31&view=staff");
    const events = calendar.props.events as ClinicEvent[];
    const visit = events.find((event) => event.id === "apt_priya_cleaning")!;
    act(() => calendar.props.onEventsChange?.(events.map((event) => event.id === visit.id ? { ...event, start: "2026-08-31T15:00:00+05:30", end: "2026-08-31T15:45:00+05:30" } : event)));
    expect(push).toHaveBeenCalledOnce();
    const url = new URL(push.mock.calls[0][0] as string, "http://localhost");
    expect(url.pathname).toBe("/appointments/apt_priya_cleaning");
    expect(url.searchParams.get("action")).toBe("reschedule");
    expect(new Date(url.searchParams.get("start")!).toISOString()).toBe("2026-08-31T09:30:00.000Z");
    expect(window.sessionStorage.getItem("kalendr-preview-appointments-v1")).toBeNull();
  });

  it("won't let a drag change how long a visit takes", () => {
    renderSchedule("?date=2026-08-31&view=staff");
    const visit = (calendar.props.events as ClinicEvent[]).find((event) => event.id === "apt_priya_cleaning")!;
    const length = Date.parse(visit.end) - Date.parse(visit.start);
    const start = new Date(visit.start);
    expect(calendar.props.constraints?.canDrop?.(visit, { start, end: new Date(start.getTime() + length) } as never)).toBe(true);
    expect(calendar.props.constraints?.canDrop?.(visit, { start, end: new Date(start.getTime() + length + 900_000) } as never)).toBe(false);
  });

  it("keeps a selected opening through the patient step and returns to Schedule context", async () => {
    const user = userEvent.setup();
    render(<NewAppointmentTask from="schedule" initialDate="2026-08-31" initialView="week" initialLocation="loc_indiranagar" initialService="service_cleaning" initialStart="2026-08-31T12:00:00+05:30" initialPractitioner="practitioner_mira" initialResource="resource_hygiene" />);
    expect(screen.getByRole("link", { name: "Back to Schedule" })).toHaveAttribute("href", "/schedule?date=2026-08-31&view=week&location=loc_indiranagar");
    await user.click(screen.getByRole("button", { name: /Ananya Rao/ }));
    await user.click(screen.getByRole("button", { name: /Choose service and time/ }));
    expect(screen.getByRole("combobox", { name: "Service" })).toHaveTextContent(/Routine cleaning/);
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: /Mon, 31 Aug, 12:00 pm.*Mira Sen.*Hygiene bay/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Review appointment" }));
    await user.click(screen.getByRole("button", { name: "Confirm appointment" }));
    expect(screen.getByRole("link", { name: "Return to Schedule" })).toHaveAttribute("href", "/schedule?date=2026-08-31&view=week&location=loc_indiranagar");
  });

  it("requires review and acknowledgment for a block that touches only an existing buffer", async () => {
    const user = userEvent.setup();
    const addScheduleBlock = vi.fn(() => true);
    render(<SchedulePlanningPanel appointments={demoAppointments} patients={demoPatients} locationId="loc_indiranagar" selectedDay="2026-08-31" availability={defaultScheduleAvailability} previewClock="2026-08-31T10:45:00+05:30" addScheduleBlock={addScheduleBlock} removeScheduleBlock={() => true} addRecurringSeries={() => true} recordAudits={() => true} auditCount={0} />);
    await user.click(screen.getByRole("button", { name: /Block time or leave/ }));
    await chooseOption(user, screen.getByRole("combobox", { name: "Block" }), "Room or chair");
    await chooseOption(user, screen.getByRole("combobox", { name: "Target" }), "Hygiene bay");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "09:15" } });
    fireEvent.change(screen.getByLabelText("Until"), { target: { value: "09:25" } });
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Maintenance");
    await user.click(screen.getByRole("button", { name: "Review blocked time" }));
    expect(screen.getByText(/Affected bookings \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Priya Patel/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm blocked time" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I have reviewed the affected bookings/ }));
    await user.click(screen.getByRole("button", { name: "Confirm blocked time" }));
    expect(addScheduleBlock).toHaveBeenCalledOnce();
  });

  it("shows every recurring occurrence and prevents a partial series when one conflicts", async () => {
    const user = userEvent.setup();
    const addRecurringSeries = vi.fn(() => true);
    render(<SchedulePlanningPanel appointments={demoAppointments} patients={demoPatients} locationId="loc_indiranagar" selectedDay="2026-08-31" availability={defaultScheduleAvailability} previewClock="2026-08-31T10:45:00+05:30" addScheduleBlock={() => true} removeScheduleBlock={() => true} addRecurringSeries={addRecurringSeries} recordAudits={() => true} auditCount={0} />);
    await user.click(screen.getByRole("button", { name: /Recurring series/ }));
    await chooseOption(user, screen.getByRole("combobox", { name: "Patient" }), "Ananya Rao");
    await user.click(screen.getByRole("combobox", { name: "Service" }));
    await screen.findByRole("option", { name: /Routine cleaning/ });
    expect(screen.queryByRole("option", { name: /New patient consultation/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Routine cleaning/ }));
    await chooseOption(user, screen.getByRole("combobox", { name: "Practitioner" }), "Mira Sen");
    await chooseOption(user, screen.getByRole("combobox", { name: "Room or chair" }), "Hygiene bay");
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "11:00" } });
    await user.click(screen.getByRole("button", { name: "Review every occurrence" }));
    expect(screen.getByText(/Week 1 · 2026-08-31 11:00/)).toBeInTheDocument();
    expect(screen.getByText(/Week 2 · 2026-09-07 11:00/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm 3 appointments/ })).toBeDisabled();
    expect(addRecurringSeries).not.toHaveBeenCalled();
  });

  it("marks a past booked visit no-show only after explicit review", async () => {
    const user = userEvent.setup();
    render(<AppointmentTask appointmentId="apt_priya_cleaning" />);
    await user.click(screen.getByRole("button", { name: "Mark no-show" }));
    expect(window.sessionStorage.getItem("kalendr-preview-appointments-v1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm mark no-show" }));
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem("kalendr-preview-appointments-v1") ?? "[]").find((item: { id: string; status: string }) => item.id === "apt_priya_cleaning")?.status).toBe("no_show"));
  });
});
