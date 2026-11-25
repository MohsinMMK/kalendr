/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { chooseOption } from "@/test/choose-option";
import { TestQueryProvider } from "@/test/query-wrapper";

import { PrivacyRequestsWorkspace, dueText } from "./privacy-requests-workspace";
import { PrivacySettings } from "./privacy-settings";

vi.mock("./clinic-catalog", () => ({ useCatalogLookups: () => ({ database: true }) }));

/** Stands in for the step-up dialog: when the server asks for a fresh code, "enter" it and repeat the call once. */
const codeAsked = vi.fn();
vi.mock("./step-up-dialog", () => ({
  useStepUp: () => ({
    runWithStepUp: async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (cause: unknown) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "step_up_required") {
          codeAsked();
          return action();
        }
        throw cause;
      }
    },
  }),
}));

type Reply = { status?: number; body: unknown };
function mockFetch(handler: (url: string, init?: RequestInit) => Reply | Promise<Reply>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const result = await handler(url, init);
    const status = result.status ?? 200;
    return { ok: status < 400, status, json: async () => result.body } as Response;
  }));
  return calls;
}
const fail = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message } } });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); codeAsked.mockClear(); });

function request(over: Record<string, unknown> = {}) {
  return {
    id: "req1", type: "erasure", status: "requested", createdAt: "2026-11-01T00:00:00Z", dueAt: "2027-01-30T00:00:00Z", daysRemaining: 41, overdue: false,
    decisionReason: null, decisionNote: null, decidedAt: null, completedAt: null, note: "Please remove me.", summary: null, version: 1,
    patientId: "p1", customerName: "Asha Rao", requestedVia: "portal", handledByUserId: null, ...over,
  };
}
const list = (requests: unknown[], counts = { open: requests.length, overdue: 0 }): Reply => ({ body: { data: { requests, counts } } });
const renderRequests = () => render(<TestQueryProvider><PrivacyRequestsWorkspace /></TestQueryProvider>);

describe("staff privacy requests", () => {
  it("words the deadline in text, and flags an overdue request with words", () => {
    expect(dueText({ daysRemaining: 41, overdue: false, dueAt: "x" })).toBe("41 days left");
    expect(dueText({ daysRemaining: 0, overdue: false, dueAt: "x" })).toBe("Due today");
    expect(dueText({ daysRemaining: -3, overdue: true, dueAt: "x" })).toBe("Overdue by 3 days");
  });

  it("shows loading, then the list with an overdue flag, a heading and review buttons", async () => {
    let release: (reply: Reply) => void = () => undefined;
    mockFetch(() => new Promise<Reply>((resolve) => { release = resolve; }));
    renderRequests();
    expect(screen.getByRole("heading", { name: "Privacy requests" })).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "Loading privacy requests" })).toBeInTheDocument();
    release(list([request({ daysRemaining: -3, overdue: true }), request({ id: "req2", customerName: "Kabir Rao", type: "export" })], { open: 2, overdue: 1 }));
    expect(await screen.findByText("Overdue by 3 days")).toBeInTheDocument();
    expect(screen.getByText("1 overdue")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Review request/ })).toHaveLength(2);
  });

  it("shows an empty state, and an error with a retry that loads again", async () => {
    const user = userEvent.setup();
    let ok = false;
    mockFetch(() => ok ? list([]) : fail(500, "internal_error", "The server had a problem."));
    renderRequests();
    expect(await screen.findByText("The server had a problem.")).toBeInTheDocument();
    ok = true;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No requests here")).toBeInTheDocument();
  });

  it("asks the server for the filter that was chosen", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(() => list([]));
    renderRequests();
    await screen.findByText("No requests here");
    await chooseOption(user, screen.getByRole("combobox", { name: "Kind" }), "Deletions");
    await waitFor(() => expect(calls.some((call) => call.url.includes("type=erasure"))).toBe(true));
    await chooseOption(user, screen.getByRole("combobox", { name: "Show" }), "Overdue");
    await waitFor(() => expect(calls.some((call) => call.url.includes("overdue=true"))).toBe(true));
  });

  it("approves an erasure through the code check, repeating the same call with the same key and version", async () => {
    const user = userEvent.setup();
    let patches = 0;
    const calls = mockFetch((url, init) => {
      if (init?.method === "PATCH") {
        patches += 1;
        return patches === 1 ? fail(403, "step_up_required", "Enter a code.") : { body: { data: request({ status: "approved", version: 2 }) } };
      }
      return list([request()]);
    });
    renderRequests();
    await user.click(await screen.findByRole("button", { name: /Review request/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Please remove me.")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Queued\. We will remove their details shortly/)).toBeInTheDocument();
    expect(codeAsked).toHaveBeenCalledTimes(1);
    const sent = calls.filter((call) => call.init?.method === "PATCH");
    expect(sent).toHaveLength(2);
    const headers = sent.map((call) => (call.init?.headers as Record<string, string>)["Idempotency-Key"]);
    expect(headers[0]).toBeTruthy();
    expect(headers[0]).toBe(headers[1]);
    expect(JSON.parse(String(sent[1]?.init?.body))).toEqual({ decision: "approve", reason: "verified", version: 1 });
  });

  it("will not refuse without a reason, then refuses with the reason and note chosen", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((url, init) => init?.method === "PATCH" ? { body: { data: request({ status: "refused", version: 2 }) } } : list([request({ type: "correction" })]));
    renderRequests();
    await user.click(await screen.findByRole("button", { name: /Review request/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Refuse" }));
    expect(await screen.findByText("Choose a reason before you refuse.")).toBeInTheDocument();
    expect(calls.some((call) => call.init?.method === "PATCH")).toBe(false);
    await chooseOption(user, screen.getByRole("combobox", { name: "Reason" }), "We must keep this information");
    await user.type(screen.getByRole("textbox", { name: /Note/ }), "Billing rules.");
    await user.click(screen.getByRole("button", { name: "Refuse" }));
    expect(await screen.findByText(/Refused\. The \w+ will see your reason\./)).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((call) => call.init?.method === "PATCH")?.init?.body))).toEqual({ decision: "refuse", reason: "legal_retention", note: "Billing rules.", version: 1 });
  });

  it("says so and reloads when someone else decided first", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((url, init) => init?.method === "PATCH" ? fail(409, "version_conflict", "Someone else changed this request.") : list([request()]));
    renderRequests();
    await user.click(await screen.findByRole("button", { name: /Review request/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Someone else already dealt with this request. The list is updated.")).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((call) => !call.init?.method || call.init.method === "GET").length).toBeGreaterThan(1));
  });
});

const retention = {
  policies: [
    { dataKind: "login_codes", keepDays: 1, action: "delete", isDefault: true, label: "Sign-in codes", description: "Codes for signing in.", editable: false, minDays: 1, maxDays: 1 },
    { dataKind: "message_log", keepDays: 365, action: "delete", isDefault: true, label: "Message log", description: "When messages were sent.", editable: true, minDays: 30, maxDays: 3650 },
    { dataKind: "medical_records", keepDays: 2555, action: "delete", isDefault: true, label: "Medical records", description: "Visit records.", editable: true, minDays: 365, maxDays: 36500 },
  ],
};

describe("staff privacy settings", () => {
  it("saves only the changed retention period, through the code check", async () => {
    const user = userEvent.setup();
    let puts = 0;
    const calls = mockFetch((url, init) => {
      if (init?.method === "PUT") {
        puts += 1;
        return puts === 1 ? fail(403, "step_up_required", "Enter a code.") : { body: { data: { policies: retention.policies.map((policy) => policy.dataKind === "message_log" ? { ...policy, keepDays: 180, isDefault: false } : policy) } } };
      }
      if (url.endsWith("/retention")) return { body: { data: retention } };
      return { body: { data: { collected: [{ what: "Name and phone", why: "To book visits", keptFor: "While they are a customer" }], sharedWith: [{ provider: "Resend", receives: "Email address", why: "To send email", active: true }], retention } } };
    });
    render(<TestQueryProvider><PrivacySettings /></TestQueryProvider>);
    const field = await screen.findByLabelText("Message log");
    await user.clear(field);
    await user.type(field, "180");
    await user.click(screen.getByRole("button", { name: "Save retention periods" }));
    await waitFor(() => expect(codeAsked).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(puts).toBe(2));
    expect(JSON.parse(String(calls.find((call) => call.init?.method === "PUT")?.init?.body))).toEqual({ policies: [{ dataKind: "message_log", keepDays: 180, action: "delete" }] });
    expect(await screen.findByText("What is collected")).toBeInTheDocument();
    expect(screen.getByText("Resend")).toBeInTheDocument();
    expect(screen.getByText(/You cannot edit it here yet/)).toBeInTheDocument();
  });

  it("refuses a period outside the allowed range before calling the server", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((url) => url.endsWith("/retention") ? { body: { data: retention } } : { body: { data: { collected: [], sharedWith: [], retention } } });
    render(<TestQueryProvider><PrivacySettings /></TestQueryProvider>);
    const field = await screen.findByLabelText("Message log");
    await user.clear(field);
    await user.type(field, "5");
    await user.click(screen.getByRole("button", { name: "Save retention periods" }));
    expect(await screen.findByText("Enter a whole number of days from 30 to 3650.")).toBeInTheDocument();
    expect(calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  it("never says the product is compliant", async () => {
    mockFetch((url) => url.endsWith("/retention") ? { body: { data: retention } } : { body: { data: { collected: [], sharedWith: [], retention } } });
    const view = render(<TestQueryProvider><PrivacySettings /></TestQueryProvider>);
    await screen.findByLabelText("Message log");
    expect(view.container.textContent ?? "").not.toMatch(/compliant/i);
  });
});
