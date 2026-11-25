/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoLocations, demoPractitioners, demoServices } from "@/lib/demo-data";
import type { ServiceSetup } from "@/lib/service-setup";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { noticeMinutes, noticeParts, priceFromText } from "./service-editor-model";
import { ServiceEditor, serviceEditorTabs } from "./service-editor";
import { serviceEditorGroups } from "./service-editor-registry";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { StaffSnapshotProvider } from "./staff-snapshot-provider";

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

afterEach(() => {
  cleanup();
  push.mockClear();
  vi.unstubAllGlobals();
});

const service = demoServices[0]!;

function setupFixture(version = 1): ServiceSetup {
  return {
    id: service.id, version,
    basics: {
      name: service.name, description: "A friendly first visit.", category: null, bookingMode: "instant", requiredResourceKind: null,
      isActive: true, visibility: "listed", slug: "first-visit", scheduleId: null, restrictionScheduleId: null, locationIds: [demoLocations[0]!.id], practitionerIds: [demoPractitioners[0]!.id],
    },
    timing: { bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 60, window: { kind: "rolling_days", days: 90 }, slotIntervalMinutes: 15, startOffsetMinutes: 0 },
    lengths: [{ minutes: 30, priceMinor: 80000, isDefault: true }],
    locationOptions: [{ kind: "in_person", locationId: demoLocations[0]!.id, note: null }],
    look: { colorLight: null, colorDark: null, bannerMediaId: null },
  };
}

function setup(handlers: { get?: () => Response; patch?: (body: unknown) => Response; del?: () => Response; initialTab?: string } = {}) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (url === "/api/staff/snapshot") return new Response(JSON.stringify({ data: staffSnapshotFixture }));
    requests.push({ url, method, body });
    if (url === `/api/staff/services/${service.id}` && method === "GET") return handlers.get?.() ?? new Response(JSON.stringify({ data: setupFixture() }));
    if (url === `/api/staff/services/${service.id}` && method === "DELETE") return handlers.del?.() ?? new Response(JSON.stringify({ data: {} }));
    if (url === `/api/staff/services/${service.id}` && method === "PATCH") return handlers.patch?.(body) ?? new Response(JSON.stringify({ data: setupFixture(2) }));
    if (url.startsWith("/api/staff/availability/schedules")) {
      const day = { "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] };
      return new Response(JSON.stringify({ data: [{ id: "sch1", practitionerId: demoPractitioners[0]!.id, name: "Tuesday afternoons", timezone: "UTC", isDefault: false, version: 1, weekly: day, overrides: [] }] }));
    }
    return new Response(JSON.stringify({ data: {} }));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={newClient()}><StaffSnapshotProvider role="owner">
      <ServiceEditor serviceId={service.id} initialTab={handlers.initialTab} />
    </StaffSnapshotProvider></QueryClientProvider>,
  );
  return requests;
}

describe("service editor helpers", () => {
  it("shows the notice in the largest whole unit and converts back", () => {
    expect(noticeParts(1440)).toEqual({ amount: 1, unit: "days" });
    expect(noticeParts(1500)).toEqual({ amount: 25, unit: "hours" });
    expect(noticeParts(90)).toEqual({ amount: 90, unit: "minutes" });
    expect(noticeMinutes(24, "hours")).toBe(1440);
  });

  it("reads a price, treating empty as 'varies' and junk as invalid", () => {
    expect(priceFromText("")).toBeNull();
    expect(priceFromText("800")).toBe(80000);
    expect(priceFromText("0")).toBe(0);
    expect(priceFromText("abc")).toBeUndefined();
  });

  it("registers the tabs in order, ready for later features to add one", () => {
    expect(serviceEditorTabs.map((tab) => tab.id)).toEqual(["basics", "lengths", "timing", "where", "look", "hours", "routing", "limits", "payment", "page", "questions", "approval", "cancelling", "calendar"]);
  });
});

describe("service editor", () => {
  it("loads the service and shows its tabs", async () => {
    setup();
    expect(await screen.findByRole("tab", { name: "Timing" })).toBeInTheDocument();
    expect(await screen.findByDisplayValue(service.name)).toBeInTheDocument();
  });

  it("offers a retry when the service cannot be loaded", async () => {
    let calls = 0;
    const requests = setup({ get: () => (++calls === 1 ? new Response(JSON.stringify({ error: { code: "x", message: "Nope." } }), { status: 500 }) : new Response(JSON.stringify({ data: setupFixture() }))) });
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByDisplayValue(service.name)).toBeInTheDocument();
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(2);
  });

  it("saves a changed buffer with the version it was loaded at", async () => {
    const requests = setup();
    await userEvent.click(await screen.findByRole("tab", { name: "Timing" }));
    const buffer = await screen.findByLabelText("Buffer after (minutes)");
    await userEvent.clear(buffer);
    await userEvent.type(buffer, "15");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = requests.find((request) => request.method === "PATCH")!;
    expect(patch.body).toMatchObject({ expectedVersion: 1, timing: { bufferAfterMinutes: 15, minimumNoticeMinutes: 60 } });
    expect(screen.getByText("Applies to new bookings only. Bookings you already have do not move.")).toBeInTheDocument();
  });

  it("says someone else changed it on a version conflict and reloads on request", async () => {
    const requests = setup({ patch: () => new Response(JSON.stringify({ error: { code: "version_conflict", message: "Someone else changed this." } }), { status: 409 }) });
    await userEvent.click(await screen.findByRole("tab", { name: "Timing" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Someone else changed this/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    // Only the service itself reloads; the Timing tab's own settings (booking options) load separately.
    await waitFor(() => expect(requests.filter((request) => request.method === "GET" && request.url === `/api/staff/services/${service.id}`)).toHaveLength(2));
  });

  it("keeps exactly one usual length and refuses repeated lengths", async () => {
    setup();
    await userEvent.click(await screen.findByRole("tab", { name: "Lengths and prices" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add a length" }));
    const usual = screen.getAllByRole("checkbox", { name: "Usual length" });
    expect(usual).toHaveLength(2);
    await userEvent.click(usual[1]!);
    expect(screen.getAllByRole("checkbox", { name: "Usual length" })[0]).not.toBeChecked();
    expect(screen.getAllByRole("checkbox", { name: "Usual length" })[1]).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Remove the 45 minute length" }));
    const remaining = screen.getAllByRole("checkbox", { name: "Usual length" });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBeChecked();
  });

  it("saves the schedule choices from the Hours tab with the normal Save", async () => {
    const requests = setup();
    await userEvent.click(await screen.findByRole("tab", { name: "Hours" }));
    await userEvent.click(await screen.findByRole("combobox", { name: /Only offer times inside/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Tuesday afternoons" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = requests.find((request) => request.method === "PATCH")?.body as { basics: { restrictionScheduleId: string | null; scheduleId: string | null } };
    expect(patch.basics.restrictionScheduleId).toBe("sch1");
    expect(patch.basics.scheduleId).toBeNull();
  });
});

describe("the Booking page tab", () => {
  it("shows the defaults when the service has none saved, and keeps at least one layout", async () => {
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Booking page" }));
    for (const name of ["Month", "Week", "Columns"]) expect(screen.getByRole("checkbox", { name })).toBeChecked();
    expect(screen.getByRole("switch", { name: /own time/ })).not.toBeChecked();
    expect(screen.getByText(/Customers abroad then see/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Week" }));
    await user.click(screen.getByRole("checkbox", { name: "Columns" }));
    expect(screen.getByRole("checkbox", { name: "Month" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("checkbox", { name: "Month" })).toBeChecked();
  });

  it("moves the first layout to an allowed one and saves everything with the normal Save", async () => {
    const requests = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Booking page" }));
    await user.click(screen.getByRole("checkbox", { name: "Month" }));
    await user.click(screen.getByRole("switch", { name: /own time/ }));
    await user.click(screen.getByRole("combobox", { name: /Week starts on/ }));
    await user.click(await screen.findByRole("option", { name: "Sunday" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = requests.find((request) => request.method === "PATCH")?.body as { bookingPage: unknown };
    expect(patch.bookingPage).toEqual({ layoutsEnabled: ["week", "column"], defaultLayout: "week", lockTimezone: true, weekStart: 7 });
  });

  it("shows the server's field error beside the field", async () => {
    setup({
      patch: () => new Response(JSON.stringify({ error: { code: "validation_failed", message: "Check the highlighted fields.", fieldErrors: { "bookingPage.defaultLayout": ["The first layout shown must be one you allow."] } } }), { status: 422 }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Booking page" }));
    await user.click(screen.getByRole("switch", { name: /own time/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findAllByText("The first layout shown must be one you allow.")).not.toHaveLength(0);
  });
});


describe("the Contact and guests tab", () => {
  it("shows the defaults when nothing is saved and saves the changes with the normal Save", async () => {
    const requests = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Contact and guests" }));
    expect(screen.getByText(/at least one so we can reach them/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /add guests/ })).not.toBeChecked();
    expect(screen.queryByText("Most guests")).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: /add guests/ }));
    await user.click(screen.getByRole("combobox", { name: /Most guests/ }));
    await user.click(await screen.findByRole("option", { name: "5" }));
    await user.click(screen.getByRole("switch", { name: "Check the email with a code" }));
    await user.click(screen.getByRole("combobox", { name: /What we ask for/ }));
    await user.click(await screen.findByRole("option", { name: "Email is required" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = requests.find((request) => request.method === "PATCH")?.body as { intake: unknown };
    expect(patch.intake).toEqual({ contactMode: "email_required", allowGuests: true, maxGuests: 5, verifyEmail: true });
  });

  it("turns the email check off and explains why for a phone-only service", async () => {
    const requests = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Contact and guests" }));
    await user.click(screen.getByRole("switch", { name: "Check the email with a code" }));
    await user.click(screen.getByRole("combobox", { name: /What we ask for/ }));
    await user.click(await screen.findByRole("option", { name: /Phone only/ }));
    expect(screen.getByText(/Confirmations go by text or WhatsApp/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Check the email with a code" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("switch", { name: "Check the email with a code" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = requests.find((request) => request.method === "PATCH")?.body as { intake: unknown };
    expect(patch.intake).toMatchObject({ contactMode: "phone_only", verifyEmail: false });
  });

  it("shows the server's field error beside the field", async () => {
    setup({
      patch: () => new Response(JSON.stringify({ error: { code: "validation_failed", message: "Check the highlighted fields.", fieldErrors: { "intake.verifyEmail": ["A phone-only service has no email to check."] } } }), { status: 422 }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Contact and guests" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("A phone-only service has no email to check.")).toBeInTheDocument();
  });
});


describe("the Approval tab", () => {
  const withApproval = (approval: ServiceSetup["approval"]) => () => new Response(JSON.stringify({ data: { ...setupFixture(), approval } }));
  const patchOf = (requests: ReturnType<typeof setup>) => requests.find((request) => request.method === "PATCH")?.body as { approval: unknown; expectedVersion: number };

  it("shows the saved rule with its hint, and hides the switches for never", async () => {
    setup({ get: withApproval({ rule: "always", noticeHours: 24, requestsHoldSlot: true, hideLocationUntilConfirmed: false }) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Approval" }));
    expect(screen.getByRole("combobox", { name: /need your approval/ })).toHaveTextContent("Always, I approve every booking");
    expect(screen.getByText("Every booking waits until you approve it.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Waiting requests keep their time" })).toBeChecked();
    await user.click(screen.getByRole("combobox", { name: /need your approval/ }));
    await user.click(await screen.findByRole("option", { name: "Never, book straight away" }));
    expect(screen.queryByRole("switch", { name: "Waiting requests keep their time" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Hide the address until approved" })).not.toBeInTheDocument();
  });

  it("reveals the hours for short notice and saves the group with the version", async () => {
    const requests = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Approval" }));
    expect(screen.queryByLabelText("Within how many hours of the start?")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: /need your approval/ }));
    await user.click(await screen.findByRole("option", { name: "Only last-minute bookings" }));
    const hours = screen.getByLabelText("Within how many hours of the start?");
    await user.clear(hours);
    await user.type(hours, "6");
    await user.click(screen.getByRole("switch", { name: "Hide the address until approved" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = patchOf(requests);
    expect(patch.expectedVersion).toBe(1);
    expect(patch.approval).toEqual({ rule: "short_notice", noticeHours: 6, requestsHoldSlot: true, hideLocationUntilConfirmed: true });
  });

  it("shows the server's field error beside the hours field", async () => {
    setup({
      get: withApproval({ rule: "short_notice", noticeHours: 24, requestsHoldSlot: true, hideLocationUntilConfirmed: false }),
      patch: () => new Response(JSON.stringify({ error: { code: "validation_failed", message: "Check the highlighted fields.", fieldErrors: { "approval.noticeHours": ["Choose between 1 and 720 hours."] } } }), { status: 422 }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Approval" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose between 1 and 720 hours.")).toBeInTheDocument();
  });

  it("asks for a whole number of hours when the field is left empty", async () => {
    const requests = setup({ get: withApproval({ rule: "short_notice", noticeHours: 24, requestsHoldSlot: true, hideLocationUntilConfirmed: false }) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Approval" }));
    await user.clear(screen.getByLabelText("Within how many hours of the start?"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/whole number of hours, from 1 to 720/)).toBeInTheDocument();
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });
});

describe("the Cancelling and moving tab", () => {
  const policy = { allowCustomerCancel: true, allowCustomerReschedule: true, cancelCutoffMinutes: 720, rescheduleCutoffMinutes: 0, rescheduleSamePerson: true, rescheduleRequestDays: 7 };
  const withPolicy = (cancelPolicy: typeof policy) => () => new Response(JSON.stringify({ data: { ...setupFixture(), cancelPolicy } }));
  const patchOf = (requests: ReturnType<typeof setup>) => requests.find((request) => request.method === "PATCH")?.body as { cancelPolicy: unknown; expectedVersion: number };

  it("shows the saved values and the live sentence", async () => {
    setup({ get: withPolicy(policy) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Cancelling and moving" }));
    expect(screen.getByRole("switch", { name: /can cancel online/ })).toBeChecked();
    expect(screen.getByLabelText(/Not within this long of the start amount/)).toHaveValue(12);
    expect(screen.getByRole("combobox", { name: /Not within this long of the start unit/ })).toHaveTextContent("hours");
    expect(screen.getByText(/can cancel up to 12 hours before the start. After that they see your phone number instead of a Cancel button./)).toBeInTheDocument();
    expect(screen.getByText(/can move their booking any time before the start/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Days .* has to choose a new time/)).toHaveValue(7);
    expect(screen.getByText(/Late-cancellation fees and refunds are set under payments/)).toBeInTheDocument();
  });

  it("saves 12 hours as 720 minutes and 2 days as 2880", async () => {
    const requests = setup({ get: withPolicy({ ...policy, cancelCutoffMinutes: 0 }) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Cancelling and moving" }));
    const amount = screen.getByLabelText(/Not within this long of the start amount/);
    await user.clear(amount);
    await user.type(amount, "12");
    await user.click(screen.getByRole("switch", { name: /Offer only the same/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = patchOf(requests);
    expect(patch.expectedVersion).toBe(1);
    expect(patch.cancelPolicy).toEqual({ ...policy, cancelCutoffMinutes: 720, rescheduleSamePerson: false });
  });

  it("converts when the unit changes", async () => {
    const requests = setup({ get: withPolicy(policy) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Cancelling and moving" }));
    await user.click(screen.getByRole("combobox", { name: /Not within this long of the start unit/ }));
    await user.click(await screen.findByRole("option", { name: "days" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    expect(patchOf(requests).cancelPolicy).toMatchObject({ cancelCutoffMinutes: 12 * 1440 });
  });

  it("hides a cut-off when its switch is off", async () => {
    setup({ get: withPolicy(policy) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Cancelling and moving" }));
    await user.click(screen.getByRole("switch", { name: /can cancel online/ }));
    expect(screen.queryByLabelText(/Not within this long of the start amount/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: /can move their booking online/ }));
    expect(screen.queryByLabelText(/to move amount/)).not.toBeInTheDocument();
  });

  it("shows the server's field error beside the cut-off", async () => {
    setup({
      get: withPolicy(policy),
      patch: () => new Response(JSON.stringify({ error: { code: "validation_failed", message: "Check the highlighted fields.", fieldErrors: { "cancelPolicy.cancelCutoffMinutes": ["Choose up to 30 days."] } } }), { status: 422 }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Cancelling and moving" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose up to 30 days.")).toBeInTheDocument();
  });

  it("refuses an empty number of days without sending", async () => {
    const requests = setup({ get: withPolicy(policy) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Cancelling and moving" }));
    await user.clear(screen.getByLabelText(/Days .* has to choose a new time/));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/whole number of days, from 1 to 60/)).toBeInTheDocument();
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });
});

describe("the full-page editor", () => {
  it("puts every tab in exactly one of the four groups, in the same ids as before", () => {
    const grouped = Object.values(serviceEditorGroups).flat();
    expect([...grouped].sort()).toEqual(serviceEditorTabs.map((tab) => tab.id).sort());
    expect(Object.keys(serviceEditorGroups)).toEqual(["setup", "experience", "policies", "automation"]);
  });

  it("opens on the tab named in the address", async () => {
    setup({ initialTab: "timing" });
    expect(await screen.findByLabelText("Buffer after (minutes)")).toBeInTheDocument();
  });

  it("shows a change of name, length or price in the preview before saving", async () => {
    setup();
    const preview = await screen.findByTestId("service-preview");
    const name = await screen.findByDisplayValue(service.name);
    await userEvent.clear(name);
    await userEvent.type(name, "Brand new name");
    expect(within(preview).getByText("Brand new name")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("tab", { name: "Lengths and prices" }));
    const minutes = await screen.findByLabelText("Minutes");
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "45");
    const price = screen.getByLabelText("Price (₹)");
    await userEvent.clear(price);
    await userEvent.type(price, "950");
    expect(within(preview).getByText(/45 min/)).toBeInTheDocument();
    expect(within(preview).getByText(/950/)).toBeInTheDocument();
  });

  it("jumps to the cancelling tab when searching for cancel", async () => {
    setup();
    await userEvent.type(await screen.findByRole("searchbox", { name: "Search settings" }), "cancel");
    await userEvent.click(await screen.findByRole("button", { name: /can cancel online/i }));
    expect(await screen.findByRole("tab", { name: "Cancelling and moving", selected: true })).toBeInTheDocument();
  });

  it("deletes after a confirmation and returns to the list", async () => {
    const requests = setup();
    await screen.findByDisplayValue(service.name);
    // Open the menu from the keyboard: under a full parallel run a pointer click on the trigger can open and close it again.
    // The header can also re-render just after the form loads, so focus the current trigger and press again until it opens.
    await waitFor(async () => {
      const trigger = screen.getByRole("button", { name: "More actions" });
      if (trigger.getAttribute("aria-expanded") !== "true") {
        trigger.focus();
        await userEvent.keyboard("{Enter}");
      }
      expect(screen.getByRole("menuitem", { name: /Delete/ })).toBeInTheDocument();
    }, { timeout: 4000 });
    // The confirmation opens with a short animation; under a full parallel run it can take more than the default second.
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    const confirm = await screen.findByRole("alertdialog", {}, { timeout: 4000 });
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(requests.some((request) => request.method === "DELETE")).toBe(true));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/services"));
  }, 15_000);
});
