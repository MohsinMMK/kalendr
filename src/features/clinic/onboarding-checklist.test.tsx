/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/dashboard" }));

import { checklistKeys, goLiveChecks, resolveSteps, summarise } from "@/lib/onboarding-steps";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { OnboardingChecklist } from "./onboarding-checklist";
import type { OnboardingState } from "./queries/onboarding";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";
import { takeSettingsRequest } from "./settings-navigation";
import { TestBookingPanel } from "./test-booking-panel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const t = { customers: "customers", services: "services" } as never;

function stateWith(options: { done?: string[]; skipped?: string[]; ready?: boolean; testRows?: number } = {}): OnboardingState {
  const marks = Object.fromEntries([
    ...(options.done ?? []).map((key) => [key, { doneAt: new Date(0), skippedAt: null }]),
    ...(options.skipped ?? []).map((key) => [key, { doneAt: null, skippedAt: new Date(0) }]),
  ]);
  const steps = resolveSteps({ marks, activeTeamMembers: 1, activeReminderWorkflows: 3, hasLogoOrColour: false, paymentsConnected: false });
  const checks = goLiveChecks({ bookableServices: options.ready === false ? 0 : 3, peopleWithHours: 1, reminderChannelWorks: true, hasPhoneAndAddress: options.ready !== false, testRows: options.testRows ?? 0 }, t);
  return {
    steps: steps.map((step) => ({ key: step.key, status: step.status, optional: step.optional, target: step.target, actionLabel: step.actionLabel, doneAt: step.doneAt?.toISOString() ?? null })),
    summary: summarise(steps), tour: "done", sampleData: false, testRows: options.testRows ?? 0,
    goLive: { checks, clear: checks.every((check) => check.ok) },
    bookingUrl: "https://app.example/book/lotus", owner: { name: "Asha Rao", email: "asha@example.com", phone: "+919000000001" },
  };
}

interface Call { url: string; method: string; body?: unknown }

function mount(state: OnboardingState | null, extra: (call: Call) => Response | null = () => null) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const call: Call = { url, method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : undefined };
    if (url === "/api/staff/snapshot") return new Response(JSON.stringify({ data: staffSnapshotFixture }));
    calls.push(call);
    const custom = extra(call);
    if (custom) return custom;
    if (url === "/api/staff/onboarding" && call.method === "GET") return new Response(JSON.stringify({ data: state }));
    if (url === "/api/staff/onboarding" && call.method === "POST") return new Response(JSON.stringify({ data: state }));
    return new Response("{}", { status: 404 });
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StaffSnapshotProvider role="owner"><OnboardingChecklist /></StaffSnapshotProvider>
    </QueryClientProvider>,
  );
  return calls;
}
const ok = (data: unknown) => new Response(JSON.stringify({ data }));

async function openAllSteps(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "More about getting started" }));
  await user.click(await screen.findByRole("menuitem", { name: "See all steps" }));
}

describe("the Getting started card", () => {
  it("shows how far the owner has got and the next step as one button that opens the right Settings section", async () => {
    mount(stateWith());
    expect(await screen.findByText(/1 of 8 done/)).toBeVisible();
    const next = screen.getByRole("button", { name: /Confirm your/ });
    await userEvent.setup().click(next);
    expect(takeSettingsRequest()).toBe("patient");
  });

  it("lists all eight steps with done, to do or skipped, and can skip one and mark another done", async () => {
    const calls = mount(stateWith({ skipped: ["payments"] }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More about getting started" }));
    await user.click(await screen.findByRole("menuitem", { name: "See all steps" }));
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(within(list).getAllByRole("img", { name: "Done" })).toHaveLength(1);
    expect(within(list).getAllByRole("img", { name: "Skipped" })).toHaveLength(1);
    expect(within(list).getAllByRole("img", { name: "To do" })).toHaveLength(6);
    await user.click(within(list).getByRole("button", { name: "More for Add your team" }));
    await user.click(await screen.findByRole("menuitem", { name: "Skip this step" }));
    await waitFor(() => expect(calls.find((call) => call.method === "POST" && call.url === "/api/staff/onboarding")?.body).toEqual({ step: "team", action: "skip" }));
    await user.click(within(list).getByRole("button", { name: /^More for Confirm your/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark as done" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url === "/api/staff/onboarding").at(-1)?.body).toEqual({ step: "services", action: "done" }));
  });

  it("offers a step the owner finishes by doing it no hand tick", async () => {
    mount(stateWith());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More about getting started" }));
    await user.click(await screen.findByRole("menuitem", { name: "See all steps" }));
    await user.click(await screen.findByRole("button", { name: "More for Make a test booking" }));
    expect(screen.queryByRole("menuitem", { name: "Mark as done" })).not.toBeInTheDocument();
    expect(await screen.findByRole("menuitem", { name: "Skip this step" })).toBeVisible();
  });

  it("puts the go-live check in front of the link and still lets the owner copy it", async () => {
    const calls = mount(stateWith({ done: ["services", "hours", "test_booking", "brand"], ready: false, testRows: 3 }));
    const user = userEvent.setup();
    // user-event installs its own clipboard, so ours goes in after it.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await openAllSteps(user);
    await user.click(await screen.findByRole("button", { name: "Share the link" }));
    const dialog = await screen.findByRole("dialog", { name: "Share your booking link" });
    expect(within(dialog).getByText(/No .+ can be booked online yet/)).toBeVisible();
    expect(within(dialog).getByText(/Test or sample bookings and customers are still in/)).toBeVisible();
    expect(within(dialog).getAllByRole("button", { name: "Fix" })).toHaveLength(3);
    await user.click(within(dialog).getByRole("button", { name: "Copy it anyway" }));
    expect(writeText).toHaveBeenCalledWith("https://app.example/book/lotus");
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && JSON.stringify(call.body) === JSON.stringify({ step: "share_link", action: "done" }))).toBe(true));
  });

  it("clears to a plain copy button when nothing would embarrass the owner", async () => {
    mount(stateWith({ done: ["services", "hours", "test_booking", "brand"] }));
    const user = userEvent.setup();
    await openAllSteps(user);
    await user.click(await screen.findByRole("button", { name: "Share the link" }));
    const dialog = await screen.findByRole("dialog", { name: "Share your booking link" });
    expect(within(dialog).getByText(/Everything looks ready/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Copy link" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Fix" })).not.toBeInTheDocument();
  });

  it("disappears once every step is done or skipped, and for a business with no checklist", async () => {
    const finished = stateWith({ done: checklistKeys.slice(0, 5) as unknown as string[], skipped: checklistKeys.slice(5) as unknown as string[] });
    expect(finished.summary.finished).toBe(true);
    mount(finished);
    await waitFor(() => expect(screen.queryByRole("button", { name: "More about getting started" })).not.toBeInTheDocument());
    expect(screen.queryByText(/Getting started/)).not.toBeInTheDocument();
    cleanup();
    mount(null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/Getting started/)).not.toBeInTheDocument();
  });

  it("adds sample data and removes test data from the ⋯ menu, after asking", async () => {
    const calls = mount(stateWith({ testRows: 2 }), (call) => {
      if (call.url === "/api/staff/onboarding/sample-data") return ok({ added: 8 });
      if (call.url === "/api/staff/onboarding/test-data") return ok({ appointmentsRemoved: 1, customersRemoved: 1 });
      return null;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More about getting started" }));
    await user.click(await screen.findByRole("menuitem", { name: /Add sample data/ }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/staff/onboarding/sample-data" && call.method === "POST")).toBe(true));
    await user.click(screen.getByRole("button", { name: "More about getting started" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove test data" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove test and sample data?" });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(within(confirm).getByRole("button", { name: "Remove them" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/staff/onboarding/test-data" && call.method === "DELETE")).toBe(true));
  });
});

describe("the test booking panel", () => {
  const owner = { name: "Asha Rao", email: "asha@example.com", phone: "+919000000001" };

  function panel(handler: (call: Call) => Response | null) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/staff/snapshot") return new Response(JSON.stringify({ data: staffSnapshotFixture }));
      const call: Call = { url, method: options?.method ?? "GET", body: options?.body ? JSON.parse(String(options.body)) : undefined };
      calls.push(call);
      return handler(call) ?? new Response("{}", { status: 404 });
    }));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StaffSnapshotProvider role="owner"><TestBookingPanel open onOpenChange={() => undefined} owner={owner} slug="lotus-dental" /></StaffSnapshotProvider>
      </QueryClientProvider>,
    );
    return calls;
  }

  it("opens the business's own page with the owner's details filled in, then shows the booking on the schedule and how the confirmation is going", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    let round = 0;
    const calls = panel((call) => {
      if (call.url !== "/api/staff/onboarding/test-booking") return null;
      round += 1;
      return ok(round === 1
        ? { found: true, appointmentId: "a1", startsAt: "2026-12-01T05:30:00.000Z", serviceName: "Haircut", confirmation: { channel: "whatsapp", status: "queued" } }
        : { found: true, appointmentId: "a1", startsAt: "2026-12-01T05:30:00.000Z", serviceName: "Haircut", confirmation: { channel: "whatsapp", status: "sent" } });
    });
    expect(screen.getByText("asha@example.com")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Start the test booking" }));
    const frame = await screen.findByTitle("Your booking page");
    const url = new URL(frame.getAttribute("src") ?? "", "http://localhost");
    expect(url.pathname).toBe("/book/lotus-dental");
    expect(Object.fromEntries(url.searchParams)).toEqual({ embed: "1", name: "Asha Rao", email: "asha@example.com", phone: "+919000000001" });
    expect(screen.getByText("Waiting for your booking…")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(await screen.findByText(/It is on your schedule: Haircut/)).toBeVisible();
    expect(screen.getByText("Your confirmation is queued as a WhatsApp message.")).toBeVisible();
    expect(screen.queryByTitle("Your booking page")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(await screen.findByText(/Your confirmation was sent as a WhatsApp message/)).toBeVisible();
    expect(calls.filter((call) => call.url === "/api/staff/onboarding/test-booking")[0]?.body).toMatchObject({ since: expect.any(String) });
    expect(screen.getByRole("button", { name: "Remove test booking" })).toBeVisible();
    expect(screen.getByRole("link", { name: "See it on the schedule" })).toHaveAttribute("href", "/schedule");
  });

  it("says the confirmation is on its way once the provider has it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    panel((call) => (call.url === "/api/staff/onboarding/test-booking" ? ok({ found: true, appointmentId: "a1", startsAt: "2026-12-01T05:30:00.000Z", serviceName: "Haircut", confirmation: { channel: "email", status: "sending" } }) : null));
    await user.click(screen.getByRole("button", { name: "Start the test booking" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(await screen.findByText("Your confirmation is on its way as an email.")).toBeVisible();
  });

  it("says plainly when the confirmation could not be sent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    panel((call) => (call.url === "/api/staff/onboarding/test-booking" ? ok({ found: true, appointmentId: "a1", startsAt: "2026-12-01T05:30:00.000Z", serviceName: "Haircut", confirmation: { channel: "sms", status: "failed" } }) : null));
    await user.click(screen.getByRole("button", { name: "Start the test booking" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(await screen.findByText(/could not be sent as a text message. Check Messages/)).toBeVisible();
  });

  it("refuses a phone number without a country code before starting", async () => {
    panel(() => null);
    const user = userEvent.setup();
    const field = screen.getByLabelText("Your mobile number");
    await user.clear(field);
    await user.type(field, "98765");
    expect(await screen.findByText("Enter your number with the country code.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start the test booking" })).toBeDisabled();
  });
});
