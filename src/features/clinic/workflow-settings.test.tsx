/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowListView, WorkflowView } from "@/lib/workflow-contracts";

import { WorkflowSettings } from "./workflow-settings";

const reminder: WorkflowView = {
  id: "wf1",
  name: "Day-before reminder",
  trigger: "before_start",
  offsetMinutes: 1440,
  filters: { serviceIds: [], locationIds: [], practitionerIds: [], bookingSources: [], deliveryModes: [] },
  active: true,
  version: 3,
  presetKey: "reminder_24h",
  sentence: "",
  steps: [{ id: "s1", channel: "email", subject: "Your appointment tomorrow", body: "Hi {customer_first_name}, see you at {time}.", templateKey: null, waitMinutes: 0, ignoreQuietHours: false, skipIfConfirmed: false }],
};

const listView = (overrides: Partial<WorkflowListView> = {}): WorkflowListView => ({
  workflows: [reminder],
  settings: { quietStartMinute: 1260, quietEndMinute: 480 },
  options: {
    services: [{ id: "svc1", name: "Check-up" }],
    locations: [{ id: "loc1", name: "Main branch" }],
    practitioners: [{ id: "p1", name: "Dr Rao" }],
    bookingSources: [{ key: "online", label: "Online" }],
    channels: [
      { key: "email", label: "Email", ready: true, reason: "" },
      { key: "whatsapp", label: "WhatsApp", ready: false, reason: "Connect WhatsApp first." },
      { key: "sms", label: "Text message", ready: false, reason: "Texts are not set up." },
    ],
  },
  unavailable: false,
  ...overrides,
});

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }
let calls: Call[];
let handler: (call: Call) => { status?: number; body: unknown };

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const result = handler(call);
    const status = result.status ?? 200;
    return { ok: status < 400, status, json: async () => result.body } as Response;
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("reminders and follow-ups settings", () => {
  it("shows each workflow as a readable sentence", async () => {
    handler = () => ({ body: { data: listView() } });
    render(<WorkflowSettings />);
    expect(await screen.findByText(/24 hours before the appointment, send Email: Your appointment tomorrow/i)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Day-before reminder is on" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Edit Day-before reminder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions for Day-before reminder" })).toBeInTheDocument();
    expect(screen.getByText(/Messages due then wait until the end, except confirmations/)).toBeInTheDocument();
  });

  it("turns on the standard set from the empty state", async () => {
    const user = userEvent.setup();
    handler = (call) => (call.method === "POST" ? { status: 200, body: { data: listView() } } : { body: { data: listView({ workflows: [] }) } });
    render(<WorkflowSettings />);
    await user.click(await screen.findByRole("button", { name: "Turn on the standard set" }));
    expect(await screen.findByText(/24 hours before the appointment/)).toBeInTheDocument();
    expect(calls.find((call) => call.method === "POST")?.url).toBe("/api/staff/workflows/presets");
  });

  it("says plainly that it is not available in the preview", async () => {
    handler = () => ({ body: { data: listView({ workflows: [], unavailable: true }) } });
    render(<WorkflowSettings />);
    expect(await screen.findByText("Not available in the preview")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New workflow|standard set/ })).not.toBeInTheDocument();
  });

  it("shows an error with a way to retry", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    handler = () => (attempt++ === 0 ? { status: 500, body: { error: { code: "server", message: "The database is busy." } } } : { body: { data: listView() } });
    render(<WorkflowSettings />);
    expect(await screen.findByText("The database is busy.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/24 hours before the appointment/)).toBeInTheDocument();
  });

  it("flags a step whose channel is not set up", async () => {
    const whatsapp = { ...reminder, steps: [{ ...reminder.steps[0]!, channel: "whatsapp" as const }] };
    handler = () => ({ body: { data: listView({ workflows: [whatsapp] }) } });
    render(<WorkflowSettings />);
    expect(await screen.findByText("WhatsApp not set up")).toBeInTheDocument();
  });

  it("refuses a value we cannot fill in", async () => {
    const user = userEvent.setup();
    handler = () => ({ body: { data: listView() } });
    render(<WorkflowSettings />);
    await user.click(await screen.findByRole("button", { name: "Edit Day-before reminder" }));
    const dialog = await screen.findByRole("dialog");
    const body = within(dialog).getByLabelText("Words of message 1");
    await user.clear(body);
    await user.type(body, "Hello {{unknown}");
    await user.click(within(dialog).getByRole("button", { name: "Save workflow" }));
    expect(await within(dialog).findByText(/\{unknown\} isn't something we can fill in/)).toBeInTheDocument();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("saves a changed timing as minutes", async () => {
    const user = userEvent.setup();
    handler = (call) => {
      if (call.method === "PATCH") return { body: { data: { ...reminder, offsetMinutes: 2880, version: 4 } } };
      return { body: { data: listView() } };
    };
    render(<WorkflowSettings />);
    await user.click(await screen.findByRole("button", { name: "Edit Day-before reminder" }));
    const dialog = await screen.findByRole("dialog");
    const amount = within(dialog).getByLabelText("Time before the start");
    fireEvent.change(amount, { target: { value: "48" } });
    await user.click(within(dialog).getByRole("button", { name: "Save workflow" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url).toBe("/api/staff/workflows/wf1");
    expect(patch.body).toMatchObject({ offsetMinutes: 2880, expectedVersion: 3, trigger: "before_start" });
    expect(await screen.findByText(/(48 hours|2 days) before the appointment/)).toBeInTheDocument();
  });

  it("keeps the ways of meeting a workflow is limited to when it is saved", async () => {
    const user = userEvent.setup();
    const videoOnly = { ...reminder, filters: { ...reminder.filters, deliveryModes: ["video" as const] } };
    handler = (call) => (call.method === "PATCH"
      ? { body: { data: { ...videoOnly, version: 4 } } }
      : { body: { data: listView({ workflows: [videoOnly] }) } });
    render(<WorkflowSettings />);
    await user.click(await screen.findByRole("button", { name: "Edit Day-before reminder" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: "Ways of meeting" })).toHaveTextContent("Video call");
    await user.click(within(dialog).getByRole("button", { name: "Save workflow" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(calls.find((call) => call.method === "PATCH")!.body).toMatchObject({ filters: { deliveryModes: ["video"] } });
  });

  it("shows a server field error next to its field", async () => {
    const user = userEvent.setup();
    handler = (call) => (call.method === "PATCH"
      ? { status: 422, body: { error: { code: "validation_failed", message: "Check the form.", fieldErrors: { "steps.0.body": ["That message is too long for email."] } } } }
      : { body: { data: listView() } });
    render(<WorkflowSettings />);
    await user.click(await screen.findByRole("button", { name: "Edit Day-before reminder" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save workflow" }));
    expect(await within(dialog).findByText("That message is too long for email.")).toBeInTheDocument();
  });

  it("tells the person to reload after a version conflict", async () => {
    const user = userEvent.setup();
    handler = (call) => (call.method === "PATCH"
      ? { status: 409, body: { error: { code: "version_conflict", message: "Changed." } } }
      : { body: { data: listView() } });
    render(<WorkflowSettings />);
    await user.click(await screen.findByRole("button", { name: "Edit Day-before reminder" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save workflow" }));
    expect(await within(dialog).findByText(/Someone else changed this workflow/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });
});
