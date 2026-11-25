/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultBookingPageSettings, type BookingPageSettings } from "@/lib/booking-page";
import { demoClinic, demoPractitioners, demoServices } from "@/lib/demo-data";
import type { Clinic, Service, TimeSlot } from "@/lib/domain";

import { createConstraints, slotAllowed, type KloqProps } from "@/components/kloq";

import { SlotPicker } from "./slot-picker";
import { render } from "./test-support";
import { useBookingDisplay } from "./use-booking-display";

const visitor = vi.hoisted(() => ({ zone: "Asia/Kolkata" }));
vi.mock("./visitor-zone", () => ({ detectVisitorZone: () => visitor.zone, detectVisitorLocale: () => "en-IN" }));

// Kloq draws on layout (sizes and pointer positions), which jsdom does not have. The stand-in keeps the props the picker
// hands it, so a test can click "a free cell" by calling `onSlotClick` the way Kloq does after a real click.
// The props the picker always sets, typed as set, so the tests can call them.
type PickerKloqProps = KloqProps & Required<Pick<KloqProps, "onSlotClick" | "onDateChange">> & {
  constraints: Required<NonNullable<KloqProps["constraints"]>>;
  components: { EventPanel: () => unknown };
};
const kloq = vi.hoisted(() => ({ props: undefined as undefined | PickerKloqProps }));
vi.mock("@/components/kloq", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/kloq")>(),
  Kloq: (props: KloqProps) => {
    kloq.props = props as PickerKloqProps;
    return <div data-testid="kloq" data-view={String(props.view)} data-date={props.date?.toDateString()} data-week-starts={props.weekStartsOn} />;
  },
}));

const person = demoPractitioners[0];
const other = demoPractitioners[1];
const slot = (id: string, startsAt: string): TimeSlot => ({ id, practitionerId: person.id, startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString() });
// Thursday 3 December 10:30 and 13:00 in Kolkata, Friday 4 December 10:30, Thursday 10 December 10:30.
const slots = [
  slot("a", "2026-12-03T05:00:00Z"),
  slot("b", "2026-12-03T07:30:00Z"),
  slot("c", "2026-12-04T05:00:00Z"),
  slot("d", "2026-12-10T05:00:00Z"),
];

function serviceWith(bookingPage: Partial<BookingPageSettings>): Service {
  return { ...demoServices[0], bookingPage: { ...defaultBookingPageSettings, ...bookingPage } };
}

function Harness({ service = serviceWith({}), clinic = demoClinic, inPerson = false, onViewRange, onSelect = vi.fn(), onTimePicked, selectedSlotId, fullDays, offered = slots, showPractitioner }: {
  onTimePicked?: () => void;
  offered?: TimeSlot[];
  showPractitioner?: boolean;
  service?: Service;
  clinic?: Clinic;
  inPerson?: boolean;
  onViewRange?: (range: { from: number; to: number }) => void;
  onSelect?: (slot: TimeSlot) => void;
  selectedSlotId?: string;
  fullDays?: string[];
}) {
  const display = useBookingDisplay({ clinic, service, businessZone: "Asia/Kolkata", locale: "en-IN", inPerson });
  return (
    <SlotPicker
      id="times"
      name="time"
      slots={offered}
      practitioners={[person, other]}
      showPractitioner={showPractitioner}
      onTimePicked={onTimePicked}
      selectedSlotId={selectedSlotId}
      onSelect={onSelect}
      locale="en-IN"
      timeZone="Asia/Kolkata"
      display={display}
      onViewRange={onViewRange}
      fullDays={fullDays}
    />
  );
}

const grid = () => screen.findByTestId("kloq");
/** What Kloq does after a click on free canvas: it hands over the snapped cell, if the constraints allow it. */
function clickCell(start: string, minutes = 30) {
  const from = new Date(start);
  const slot = { start: from, end: new Date(from.getTime() + minutes * 60_000), allDay: false };
  if (!slotAllowed(createConstraints(kloq.props!.constraints), slot)) return;
  act(() => kloq.props!.onSlotClick(slot));
}
const time = (name: RegExp) => screen.getByRole("radio", { name });

beforeEach(() => {
  visitor.zone = "Asia/Kolkata";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T06:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("layouts", () => {
  it("opens the layout from the link, and writes the choice back to the address", async () => {
    const user = userEvent.setup();
    const onUrlUpdate = vi.fn();
    render(<Harness />, { searchParams: "?layout=week" });
    const week = await grid();
    expect(week).toHaveAttribute("data-view", "week");
    expect(screen.getByRole("radio", { name: "Week" })).toBeChecked();
    cleanup();

    render(<Harness />, { searchParams: "?layout=week", onUrlUpdate });
    await user.click(await screen.findByRole("radio", { name: "Columns" }));
    expect(await screen.findByTestId("kloq")).toHaveAttribute("data-view", "3");
    expect(onUrlUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ queryString: "?layout=column" }));

    await user.click(screen.getByRole("radio", { name: "Month" }));
    expect(screen.getByRole("group", { name: "Choose a date" })).toBeInTheDocument();
    expect(onUrlUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ queryString: "?layout=month" }));
  });

  it("only opens layouts the service allows, and hides the switch when there is one", () => {
    const view = render(<Harness service={serviceWith({ layoutsEnabled: ["month", "week"], defaultLayout: "month" })} />, { searchParams: "?layout=column" });
    expect(screen.getByRole("group", { name: "Choose a date" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Columns" })).not.toBeInTheDocument();
    view.unmount();
    render(<Harness service={serviceWith({ layoutsEnabled: ["week"], defaultLayout: "week" })} />, { searchParams: "?layout=month" });
    expect(screen.queryByRole("radiogroup", { name: "View" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Choose a date" })).not.toBeInTheDocument();
  });

  it("falls back to month on a phone without rewriting the address", () => {
    const phone = (query: string) => ({ matches: query === "(max-width: 767px)", media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null });
    const original = window.matchMedia;
    window.matchMedia = phone as unknown as typeof window.matchMedia;
    try {
      const onUrlUpdate = vi.fn();
      render(<Harness />, { searchParams: "?layout=week", onUrlUpdate });
      expect(screen.getByRole("group", { name: "Choose a date" })).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Week" })).toBeChecked();
      expect(onUrlUpdate).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });

  it("starts weeks on Sunday when the service says so", async () => {
    render(<Harness service={serviceWith({ weekStart: 7 })} />, { searchParams: "?layout=week" });
    const sunday = await grid();
    expect(sunday).toHaveAttribute("data-week-starts", "0");
    expect(sunday).toHaveAttribute("data-date", "Sun Nov 29 2026");
    cleanup();
    render(<Harness service={serviceWith({ weekStart: 1 })} />, { searchParams: "?layout=week" });
    const monday = await grid();
    expect(monday).toHaveAttribute("data-week-starts", "1");
    expect(monday).toHaveAttribute("data-date", "Mon Nov 30 2026");
  });

  it("asks for the times of what is on screen when the customer pages", async () => {
    const user = userEvent.setup();
    const onViewRange = vi.fn();
    render(<Harness onViewRange={onViewRange} />, { searchParams: "?layout=week" });
    const first = onViewRange.mock.lastCall![0];
    expect(first.to - first.from).toBe(7 * 86_400_000);
    await user.click(await screen.findByRole("button", { name: "Next week" }));
    const second = onViewRange.mock.lastCall![0];
    expect(second.from).toBe(first.to);
    expect(await grid()).toHaveAttribute("data-date", "Mon Dec 07 2026");
  });
});

describe("time zone and clock", () => {
  it("shows the same openings on the clock of the zone in the link, and says how it differs from the business", () => {
    render(<Harness />, { searchParams: "?tz=Asia/Dubai" });
    expect(time(/9:00\s?am/i)).toBeInTheDocument();
    expect(time(/11:30\s?am/i)).toBeInTheDocument();
    expect(screen.getByText("Times shown in Dubai time (1 h 30 m behind the clinic).")).toBeInTheDocument();
  });

  it("shows another zone's clock too, and says nothing when the zones agree", () => {
    const view = render(<Harness />, { searchParams: "?tz=Asia/Kolkata" });
    expect(time(/10:30\s?am/i)).toBeInTheDocument();
    expect(screen.queryByText(/behind the clinic|ahead of the clinic/)).not.toBeInTheDocument();
    view.unmount();
    render(<Harness />, { searchParams: "?tz=UTC" });
    expect(time(/5:00\s?am/i)).toBeInTheDocument();
    expect(screen.getByText(/Times shown in UTC time \(5 h 30 m behind the clinic\)/)).toBeInTheDocument();
  });

  it("uses the visitor's own zone by default", () => {
    visitor.zone = "Asia/Dubai";
    render(<Harness />);
    expect(time(/9:00\s?am/i)).toBeInTheDocument();
  });

  it("changes zone from a searchable list, shares it in the address, and announces it politely", async () => {
    const user = userEvent.setup();
    const onUrlUpdate = vi.fn();
    render(<Harness />, { onUrlUpdate });
    expect(time(/10:30\s?am/i)).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Time zone" }));
    await user.keyboard("{Control>}a{/Control}Dubai");
    await user.click(await screen.findByRole("option", { name: /Asia\/Dubai/ }));

    expect(await screen.findByText("Times shown in Dubai time (1 h 30 m behind the clinic).")).toBeInTheDocument();
    expect(screen.getByText(/Times shown in Dubai time/).closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
    expect(time(/9:00\s?am/i)).toBeInTheDocument();
    expect(onUrlUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ queryString: "?tz=Asia/Dubai" }));
  });

  it("ignores a zone in the link that does not exist", () => {
    render(<Harness />, { searchParams: "?tz=Mars/Olympus" });
    expect(time(/10:30\s?am/i)).toBeInTheDocument();
  });

  it("keeps the branch's time for an in-person visit when the service locks it", () => {
    render(<Harness service={serviceWith({ lockTimezone: true })} inPerson />, { searchParams: "?tz=Asia/Dubai" });
    expect(time(/10:30\s?am/i)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Time zone" })).not.toBeInTheDocument();
    expect(screen.getByText(/In-person visits are shown in Kolkata time/)).toBeInTheDocument();
  });

  it("lets a video visit use any zone even when the service locks in-person time", () => {
    render(<Harness service={serviceWith({ lockTimezone: true })} inPerson={false} />, { searchParams: "?tz=Asia/Dubai" });
    expect(time(/9:00\s?am/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Time zone" })).toBeInTheDocument();
  });

  it("switches between a 12 and 24 hour clock, and takes the business's default", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    expect(time(/1:00\s?pm/i)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "24-hour clock" }));
    expect(time(/13:00/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "12-hour clock" }));
    expect(time(/1:00\s?pm/i)).toBeInTheDocument();
    view.unmount();
    render(<Harness clinic={{ ...demoClinic, defaultClock: "24h" }} />);
    expect(time(/13:00/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "24-hour clock" })).toBeChecked();
  });
});

describe("keyboard", () => {
  it("moves through one day's times with the arrows in the month layout", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    act(() => time(/10:30\s?am/i).focus());
    await user.keyboard("{ArrowDown}");
    expect(time(/1:00\s?pm/i)).toHaveFocus();
  });

  it("pages the week when Kloq's own keys move its date, but never to days that cannot be booked", async () => {
    const onViewRange = vi.fn();
    render(<Harness onViewRange={onViewRange} />, { searchParams: "?layout=week" });
    await grid();
    act(() => kloq.props!.onDateChange(new Date(2026, 11, 7)));
    expect(await screen.findByTestId("kloq")).toHaveAttribute("data-date", "Mon Dec 07 2026");
    expect(onViewRange.mock.lastCall![0].from).toBeGreaterThan(Date.parse("2026-12-06T00:00:00Z"));
    act(() => kloq.props!.onDateChange(new Date(2026, 10, 1)));
    expect(screen.getByTestId("kloq")).toHaveAttribute("data-date", "Mon Dec 07 2026");
    // Back to this week, which began before today: it opens, as the previous button would.
    act(() => kloq.props!.onDateChange(new Date(2026, 10, 30)));
    act(() => kloq.props!.onDateChange(new Date(2026, 10, 16)));
    expect(screen.getByTestId("kloq")).toHaveAttribute("data-date", "Mon Nov 16 2026");
  });
});

describe("week and column layouts on Kloq", () => {
  it("chooses the time under a click on free time, and moves the booking on", async () => {
    const onSelect = vi.fn();
    const onTimePicked = vi.fn();
    render(<Harness onSelect={onSelect} onTimePicked={onTimePicked} />, { searchParams: "?layout=week" });
    await grid();
    clickCell("2026-12-03T07:30:00Z");
    expect(onSelect).toHaveBeenCalledWith(slots[1]);
    expect(onTimePicked).toHaveBeenCalledTimes(1);
  });

  it("does nothing for busy, closed or past time, and hatches everything that is not an opening", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />, { searchParams: "?layout=column" });
    await grid();
    clickCell("2026-12-03T06:00:00Z");
    clickCell("2026-11-19T05:00:00Z");
    expect(onSelect).not.toHaveBeenCalled();
    // Kloq rounds a click to the nearest minute, so anywhere in the free half hour chooses it, and the edge after it does not.
    clickCell("2026-12-03T05:29:00Z");
    expect(onSelect).toHaveBeenLastCalledWith(slots[0]);
    clickCell("2026-12-03T05:30:00Z");
    expect(onSelect).toHaveBeenCalledTimes(1);
    const { constraints } = kloq.props!;
    const cell = (start: string, minutes = 30) => constraints.isSlotDisabled({ start: new Date(start), end: new Date(Date.parse(start) + minutes * 60_000), allDay: false });
    expect(cell("2026-12-03T05:00:00Z")).toBe(false);
    expect(cell("2026-12-03T05:30:00Z")).toBe(true);
    expect(cell("2026-12-03T05:20:00Z")).toBe(false);
    expect(constraints.isSlotDisabled({ start: new Date("2026-12-03T00:00:00Z"), end: new Date("2026-12-04T00:00:00Z"), allDay: true })).toBe(true);
  });

  it("draws the three or five columns, the zone and the hours of the openings, and shows the chosen time as a read-only event", async () => {
    render(<Harness selectedSlotId="b" />, { searchParams: "?layout=column" });
    await grid();
    const props = kloq.props!;
    expect(props.view).toBe(3);
    expect(props.displayTimeZone).toBe("Asia/Kolkata");
    expect(props.responsive).toBe(false);
    expect(props.dayStartHour).toBe(10);
    expect(props.dayEndHour).toBeGreaterThanOrEqual(14);
    expect(props.snapMinutes).toBe(1);
    expect(props.components.EventPanel()).toBeNull();
    expect(props.events).toEqual([expect.objectContaining({ id: "b", readOnly: true, start: slots[1].startsAt, end: slots[1].endsAt })]);
  });

  it("asks who when several people are free at the clicked start, then chooses that person", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onTimePicked = vi.fn();
    const second: TimeSlot = { id: "a2", practitionerId: other.id, startsAt: slots[0].startsAt, endsAt: slots[0].endsAt };
    render(<Harness onSelect={onSelect} onTimePicked={onTimePicked} offered={[...slots, second]} showPractitioner />, { searchParams: "?layout=week" });
    await grid();
    clickCell(slots[0].startsAt);
    expect(onSelect).not.toHaveBeenCalled();
    const who = screen.getByRole("group", { name: /Who would you like to see/ });
    await user.click(within(who).getByRole("button", { name: other.name }));
    expect(onSelect).toHaveBeenCalledWith(second);
    expect(onTimePicked).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group", { name: /Who would you like to see/ })).not.toBeInTheDocument();
    // One person free: no question.
    clickCell(slots[1].startsAt);
    expect(onSelect).toHaveBeenLastCalledWith(slots[1]);
    expect(screen.queryByRole("group", { name: /Who would you like to see/ })).not.toBeInTheDocument();
  });

  it("drops the question when the page turns, and does not bring it back on paging back", async () => {
    const second: TimeSlot = { id: "a2", practitionerId: other.id, startsAt: slots[0].startsAt, endsAt: slots[0].endsAt };
    render(<Harness offered={[...slots, second]} showPractitioner />, { searchParams: "?layout=week" });
    await grid();
    const shown = kloq.props!.date as Date;
    clickCell(slots[0].startsAt);
    expect(screen.getByRole("group", { name: /Who would you like to see/ })).toBeInTheDocument();
    act(() => kloq.props!.onDateChange(new Date(shown.getTime() + 7 * 86_400_000)));
    expect(screen.queryByRole("group", { name: /Who would you like to see/ })).not.toBeInTheDocument();
    act(() => kloq.props!.onDateChange(shown));
    expect(screen.queryByRole("group", { name: /Who would you like to see/ })).not.toBeInTheDocument();
  });

  it("names the days that are fully booked", async () => {
    render(<Harness fullDays={["2026-12-02"]} />, { searchParams: "?layout=week" });
    await grid();
    expect(screen.getByText(/Fully booked: Wed 2/)).toBeInTheDocument();
  });
});
