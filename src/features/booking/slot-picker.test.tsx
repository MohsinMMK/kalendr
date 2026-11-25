import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoPractitioners } from "@/lib/demo-data";
import type { TimeSlot } from "@/lib/domain";

import { SlotPicker } from "./slot-picker";

const slots: TimeSlot[] = [
  { id: "late", practitionerId: demoPractitioners[0].id, startsAt: "2026-09-23T05:00:00Z", endsAt: "2026-09-23T05:30:00Z" },
  { id: "early", practitionerId: demoPractitioners[0].id, startsAt: "2026-09-22T18:00:00Z", endsAt: "2026-09-22T18:30:00Z" },
  { id: "midnight", practitionerId: demoPractitioners[0].id, startsAt: "2026-09-22T19:00:00Z", endsAt: "2026-09-22T19:30:00Z" },
];
const dayButton = (name: RegExp) => screen.getByRole("button", { name });
const september22 = /September 22.*2026/;
const september23 = /September 23.*2026/;
// Each time is a toggle exposed as a radio; its id ends with the slot id.
const radioValue = (radio: HTMLElement) => radio.id.replace(/^time-/, "");
const props = { id: "times", name: "time", slots, practitioners: demoPractitioners, locale: "en-IN", timeZone: "Asia/Kolkata", onSelect: vi.fn() };

afterEach(cleanup);

describe("date-first time selection", () => {
  it("groups by clinic date and renders only that day's chronologically ordered times", async () => {
    const user = userEvent.setup();
    render(<SlotPicker {...props} />);
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(radioValue(screen.getByRole("radio"))).toBe("early");
    await user.click(dayButton(september23));
    expect(screen.getAllByRole("radio").map(radioValue)).toEqual(["midnight", "late"]);
    await user.click(screen.getAllByRole("radio")[1]);
    expect(props.onSelect).toHaveBeenCalledWith(slots[0]);
  });

  it("reopens a selected date and keeps the existing selection visible when browsing elsewhere", async () => {
    const user = userEvent.setup();
    render(<SlotPicker {...props} selectedSlotId="late" />);
    expect(dayButton(september23).closest("[data-selected]")).not.toBeNull();
    expect(radioValue(screen.getByRole("radio", { checked: true }))).toBe("late");
    await user.click(dayButton(september22));
    expect(screen.getByText(/Selected:/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View selected time" }));
    expect(radioValue(screen.getByRole("radio", { checked: true }))).toBe("late");
  });

  it("opens on the day from a link when it has times, and on the earliest day when it does not", () => {
    const view = render(<SlotPicker {...props} initialDate="2026-09-23" />);
    expect(screen.getAllByRole("radio").map(radioValue)).toEqual(["midnight", "late"]);
    view.unmount();
    render(<SlotPicker {...props} initialDate="2026-09-30" />);
    expect(screen.getAllByRole("radio").map(radioValue)).toEqual(["early"]);
  });

  it("recovers when refreshed availability no longer contains the browsed date", async () => {
    const user = userEvent.setup();
    const view = render(<SlotPicker {...props} />);
    await user.click(dayButton(september23));
    view.rerender(<SlotPicker {...props} slots={[slots[1]]} />);
    expect(dayButton(september22).closest("[data-selected]")).not.toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    view.rerender(<SlotPicker {...props} slots={[]} />);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});
