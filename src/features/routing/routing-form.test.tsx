/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FormField } from "@/lib/booking-forms";
import type { PublicRoutingForm } from "@/lib/routing-forms";

import { RoutingForm } from "./routing-form";

const assign = vi.fn();
const field = (patch: Partial<FormField> & Pick<FormField, "id" | "label" | "type">): FormField => ({ required: true, ...patch }) as FormField;

const form: PublicRoutingForm = {
  name: "Find the right service",
  intro: "Two quick questions.",
  businessName: "Riverside",
  questions: [
    field({ id: "q_first", label: "Is this your first visit?", type: "yes_no" }),
    field({ id: "q_why", label: "What brings you in?", type: "short_text", showWhen: [{ fieldId: "q_first", operator: "equals", value: "Yes" }] }),
  ],
};

const response = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

function stub(submit: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/open")) return response({ data: { token: "token-token-token-token-1" } }, 201);
    expect(init?.method).toBe("POST");
    return submit();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const submitCalls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/open"));

beforeEach(() => {
  vi.stubGlobal("location", { ...window.location, assign });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  assign.mockReset();
});

function setup() {
  render(<RoutingForm clinicSlug="riverside" formSlug="find" form={form} />);
  return userEvent.setup();
}

describe("RoutingForm", () => {
  it("shows a conditional question only when its answer is given", async () => {
    stub(() => response({ data: { type: "message", title: "t", body: "b" } }));
    const user = setup();
    expect(screen.getByRole("heading", { name: "Find the right service" })).toBeInTheDocument();
    expect(screen.queryByText("What brings you in?")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(screen.getByText("What brings you in?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(screen.queryByText("What brings you in?")).not.toBeInTheDocument();
  });

  it("explains missing required answers and sends nothing", async () => {
    const fetchMock = stub(() => response({ data: { type: "message", title: "t", body: "b" } }));
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Choose yes or no.")).toBeInTheDocument();
    expect(submitCalls(fetchMock)).toHaveLength(0);
  });

  it("opens the form once and sends the token with the answers", async () => {
    const fetchMock = stub(() => response({ data: { type: "booking", url: "/book/riverside?service=s1&routing=abc" } }));
    const user = setup();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/public/routing/riverside/find/open", expect.anything()));
    await user.click(screen.getByRole("button", { name: "No" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/book/riverside?service=s1&routing=abc"));
    const [, init] = submitCalls(fetchMock)[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ answers: { q_first: false }, responseToken: "token-token-token-token-1" });
  });

  it("follows an external outcome", async () => {
    stub(() => response({ data: { type: "external", url: "https://example.com/next" } }));
    const user = setup();
    await user.click(screen.getByRole("button", { name: "No" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://example.com/next"));
  });

  it("shows a message outcome in place", async () => {
    stub(() => response({ data: { type: "message", title: "We will call you", body: "Expect a call today." } }));
    const user = setup();
    await user.click(screen.getByRole("button", { name: "No" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "We will call you" })).toBeInTheDocument();
    expect(screen.getByText("Expect a call today.")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows the server's field errors beside the question", async () => {
    stub(() => response({ error: { code: "validation_error", message: "Check", fieldErrors: { q_first: ["Pick one of the choices."] } } }, 400));
    const user = setup();
    await user.click(screen.getByRole("button", { name: "No" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Pick one of the choices.")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("tells the customer to wait after a rate limit and lets them retry", async () => {
    stub(() => response({ error: { code: "rate_limited", message: "Too many tries. Wait a minute." } }, 429));
    const user = setup();
    await user.click(screen.getByRole("button", { name: "No" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Too many tries. Wait a minute.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("still works when opening the form fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/open")) throw new Error("offline");
      return response({ data: { type: "external", url: "https://example.com/x" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = setup();
    await user.click(screen.getByRole("button", { name: "No" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const [, init] = submitCalls(fetchMock)[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ answers: { q_first: false } });
  });
});
