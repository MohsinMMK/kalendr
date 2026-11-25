/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SeriesPreview } from "@/lib/series-contracts";
import { chooseOption } from "@/test/choose-option";

import { RepeatControl, RepeatReview } from "./repeat-booking";
import { noRepeat, type RepeatDraft } from "./repeat-model";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

const preview = (clash: boolean): SeriesPreview => ({
  timezone: "Asia/Kolkata", startsOn: "2026-11-24", timeOfDay: "10:00", ruleText: "RRULE:FREQ=WEEKLY;COUNT=3", capped: false,
  freeCount: clash ? 2 : 3, clashCount: clash ? 1 : 0,
  visits: [
    { index: 1, date: "2026-11-24", startsAt: "2026-11-24T04:30:00.000Z", endsAt: "2026-11-24T05:30:00.000Z", state: "free", alternatives: [] },
    clash
      ? { index: 2, date: "2026-12-01", startsAt: "2026-12-01T04:30:00.000Z", endsAt: "2026-12-01T05:30:00.000Z", state: "clash", reason: "already_booked", reasonLabel: "Already booked", alternatives: [{ startsAt: "2026-12-01T05:30:00.000Z", endsAt: "2026-12-01T06:30:00.000Z" }] }
      : { index: 2, date: "2026-12-01", startsAt: "2026-12-01T04:30:00.000Z", endsAt: "2026-12-01T05:30:00.000Z", state: "free", alternatives: [] },
    { index: 3, date: "2026-12-08", startsAt: "2026-12-08T04:30:00.000Z", endsAt: "2026-12-08T05:30:00.000Z", state: "free", alternatives: [] },
  ],
});

function Control({ initial = noRepeat }: { initial?: RepeatDraft }) {
  const [draft, setDraft] = useState(initial);
  return <RepeatControl draft={draft} onChange={setDraft} startsOn="2026-11-24" time="10:00" />;
}

describe("the Repeat control", () => {
  it("starts as 'does not repeat' with no extra fields", () => {
    render(<Control />);
    expect(screen.getByText(/Turn this on to book the same/)).toBeInTheDocument();
    expect(screen.queryByText("Every Tuesday at 10:00 am for 8 weeks")).not.toBeInTheDocument();
  });

  it("says what it will book once it repeats, and follows the choices", async () => {
    const user = userEvent.setup();
    render(<Control />);
    await chooseOption(user, screen.getByRole("combobox", { name: /Repeat this/ }), "Every week, on chosen days");
    expect(await screen.findByRole("status")).toHaveTextContent("Every Tuesday at 10:00 am for 8 weeks");
    await user.click(screen.getByRole("button", { name: "Friday" }));
    expect(screen.getByRole("status")).toHaveTextContent("Every Tuesday and Friday at 10:00 am for 8 visits");
    const count = screen.getByRole("spinbutton", { name: /How many times/ });
    await user.clear(count);
    await user.type(count, "60");
    expect(screen.getByRole("alert")).toHaveTextContent("Choose between 2 and 52 times.");
  });

  it("offers the end as a number of times or a date, and every week day by name", async () => {
    const user = userEvent.setup();
    render(<Control initial={{ ...noRepeat, mode: "weekly" }} />);
    expect(screen.getByRole("button", { name: "Tuesday" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("button", { name: /day$/ })).toHaveLength(7);
    await user.click(screen.getByRole("button", { name: "On a date" }));
    expect(screen.getByText("Last day")).toBeInTheDocument();
  });
});

function review(onSaved = vi.fn(), onBack = vi.fn()) {
  render(<RepeatReview summary="Every Tuesday at 10:00 am for 3 weeks" onSaved={onSaved} onBack={onBack}
    booking={{ clinicSlug: "lotus", locationId: "l1", serviceId: "s1", practitionerId: "p1", startsAt: "2026-11-24T04:30:00.000Z", source: "desk", patientId: "pt1" }}
    rule={{ frequency: "weekly", interval: 1, weekdays: [2], end: { kind: "count", count: 3 } }} />);
  return { onSaved, onBack };
}

describe("checking every date before saving", () => {
  it("shows the dates while it checks, then marks each free or clashing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: preview(true) })));
    review();
    expect(screen.getByText("Checking every date…")).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: /Every .* in the series/ });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getAllByText("Free")).toHaveLength(2);
    expect(within(list).getByText("Already booked")).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 are free/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Book/ })).toBeDisabled(); // a clash is still unanswered
  });

  it("books everything once each clash has an answer, in one request with one key", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/staff/series/preview") return json({ data: preview(true) });
      expect(init?.method).toBe("POST");
      return json({ data: { saved: true, seriesId: "series1", visitCount: 3, skippedCount: 0, appointmentIds: ["a1", "a2", "a3"] } }, 201);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { onSaved } = review();
    const choice = await screen.findByRole("combobox", { name: /What to do about/ });
    await chooseOption(user, choice, /Move to 11:00 am/);
    await user.click(screen.getByRole("button", { name: "Book 3 appointments" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ seriesId: "series1", visitCount: 3 })));
    const save = fetchMock.mock.calls.find(([url]) => url === "/api/staff/series")!;
    expect(JSON.parse(String((save[1] as RequestInit).body)).resolutions).toEqual([{ index: 2, action: "move", startsAt: "2026-12-01T05:30:00.000Z" }]);
    expect((save[1] as RequestInit).headers).toMatchObject({ "Idempotency-Key": expect.any(String) });
  });

  it("can skip a clashing visit and books the rest", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/preview") ? json({ data: preview(true) }) : json({ data: { saved: true, seriesId: "s", visitCount: 2, skippedCount: 1, appointmentIds: ["a", "b"] } }, 201)));
    const { onSaved } = review();
    await chooseOption(user, await screen.findByRole("combobox", { name: /What to do about/ }), "Skip this one");
    expect(screen.getByText("Skipped")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Book 2 appointments" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("shows the list again, with nothing booked, when the server says something changed", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/preview")
      ? json({ data: preview(false) })
      : json({ data: { saved: false, preview: preview(true) } }, 409)));
    const { onSaved } = review();
    await screen.findByText("Every date is free.");
    await user.click(screen.getByRole("button", { name: "Book 3 appointments" }));
    expect(await screen.findByText(/nothing was booked/)).toBeInTheDocument();
    expect(screen.getByText("Already booked")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("says what went wrong and lets staff try again", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (attempts += 1) === 1 ? json({ error: { code: "internal_error", message: "The request could not be completed." } }, 500) : json({ data: preview(false) })));
    review();
    expect(await screen.findByText("The request could not be completed.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("Every date is free.")).toBeInTheDocument();
  });

  it("goes back without saving", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: preview(false) })));
    const { onBack } = review();
    await screen.findByText("Every date is free.");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });
});
