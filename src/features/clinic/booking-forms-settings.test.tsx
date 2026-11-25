/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormDefinition } from "@/lib/booking-forms";
import { ToastProvider } from "@/components/ui/toast";
import { demoServices } from "@/lib/demo-data";
import { staffSnapshotFixture } from "@/test/staff-fixture";

import { moveBlocker, prunedOverrides, setRequiredChoice } from "./booking-form-rules";
import { BookingFormsSettings } from "./booking-forms-settings";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const [serviceA, serviceB] = demoServices;

function form(overrides: Partial<FormDefinition> = {}): FormDefinition {
  return {
    id: "row1", key: "intake", version: 1, name: "Before you come", description: "", isActive: true, appliesToAll: true, serviceIds: [], updatedAt: "2026-01-01T00:00:00Z",
    fields: [
      { id: "q1", type: "single_choice", label: "How did you hear about us?", required: false, options: ["A friend", "Online", "Other"] },
      { id: "q2", type: "short_text", label: "Which friend?", required: false },
      { id: "q3", type: "long_text", label: "Anything else?", required: true },
    ],
    ...overrides,
  };
}

function setup(definition: FormDefinition, patchResponse?: () => Response) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/staff/snapshot") return new Response(JSON.stringify({ data: staffSnapshotFixture }));
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/staff/forms" && method === "GET") return new Response(JSON.stringify({ data: [definition] }));
    if (method === "PATCH" && patchResponse) return patchResponse();
    return new Response(JSON.stringify({ data: {} }));
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><StaffSnapshotProvider role="owner"><BookingFormsSettings /></StaffSnapshotProvider></ToastProvider>
    </QueryClientProvider>,
  );
  return requests;
}

async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Edit Before you come" }));
}

const question = (number: number) => screen.getByRole("group", { name: `Question ${number}` });
const savedBody = (requests: ReturnType<typeof setup>) => requests.find((request) => request.method === "PATCH")?.body as { fields: Array<Record<string, unknown>>; requiredOverrides?: unknown };

describe("show this when", () => {
  it("offers only earlier questions and the operators for that kind of question, and saves the condition", async () => {
    const requests = setup(form());
    const user = userEvent.setup();
    await openForm(user);
    // The first question cannot depend on anything.
    expect(within(question(1)).getByRole("switch", { name: /Show this when/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(within(question(2)).getByRole("switch", { name: /Show this when/ }));
    await user.click(within(question(2)).getByRole("combobox", { name: "Condition 1: earlier question" }));
    const sources = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(sources).toEqual(["Question 1: How did you hear about us?"]);
    await user.keyboard("{Escape}");
    await user.click(within(question(2)).getByRole("combobox", { name: "Condition 1: how the answer compares" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["is", "is not", "is one of"]);
    await user.keyboard("{Escape}");
    await user.click(within(question(2)).getByRole("combobox", { name: "Condition 1: answer" }));
    await user.click(await screen.findByRole("option", { name: "A friend" }));
    await user.click(screen.getByRole("button", { name: "Save booking form" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    expect(savedBody(requests).fields[1]).toMatchObject({ id: "q2", showWhen: [{ fieldId: "q1", operator: "equals", value: "A friend" }] });
    expect(savedBody(requests).fields[0]).not.toHaveProperty("showWhen");
  });

  it("takes several answers for 'is one of'", async () => {
    const requests = setup(form());
    const user = userEvent.setup();
    await openForm(user);
    await user.click(within(question(2)).getByRole("switch", { name: /Show this when/ }));
    await user.click(within(question(2)).getByRole("combobox", { name: "Condition 1: how the answer compares" }));
    await user.click(await screen.findByRole("option", { name: "is one of" }));
    await user.click(within(question(2)).getByRole("combobox", { name: "Condition 1: answer" }));
    await user.click(await screen.findByRole("option", { name: "Online" }));
    await user.click(await screen.findByRole("option", { name: "Other" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Save booking form" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const condition = (savedBody(requests).fields[1]?.showWhen as Array<{ fieldId: string; operator: string; value: string[] }>)[0];
    expect(condition?.operator).toBe("one_of");
    expect(condition?.value).toEqual(["A friend", "Online", "Other"]);
  });

  it("allows at most three conditions", async () => {
    setup(form({ fields: [...form().fields, { id: "q4", type: "short_text", label: "Fourth", required: false }] }));
    const user = userEvent.setup();
    await openForm(user);
    await user.click(within(question(4)).getByRole("switch", { name: /Show this when/ }));
    for (let at = 0; at < 2; at += 1) await user.click(within(question(4)).getByRole("button", { name: "Add a condition" }));
    expect(within(question(4)).getByRole("button", { name: "Add a condition" })).toBeDisabled();
    expect(within(question(4)).getAllByRole("group", { name: /Condition \d/ })).toHaveLength(3);
  });

  it("refuses to move a question above the one it depends on", async () => {
    setup(form({ fields: [form().fields[0]!, { ...form().fields[1]!, showWhen: [{ fieldId: "q1", operator: "equals", value: "A friend" }] }, form().fields[2]!] }));
    const user = userEvent.setup();
    await openForm(user);
    await user.click(within(question(2)).getByRole("button", { name: "More for question 2" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move up" }));
    expect(await screen.findByText(/has to stay after it/)).toBeInTheDocument();
    expect(within(question(1)).getByDisplayValue("How did you hear about us?")).toBeInTheDocument();
  });

  it("drops the conditions that point at a question when it is removed", async () => {
    const requests = setup(form({ fields: [form().fields[0]!, { ...form().fields[1]!, showWhen: [{ fieldId: "q1", operator: "equals", value: "A friend" }] }, form().fields[2]!] }));
    const user = userEvent.setup();
    await openForm(user);
    await user.click(within(question(1)).getByRole("button", { name: "More for question 1" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Save booking form" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    expect(savedBody(requests).fields.map((field) => field.id)).toEqual(["q2", "q3"]);
    expect(savedBody(requests).fields[0]).not.toHaveProperty("showWhen");
  });

  it("shows the server's error beside the condition it names", async () => {
    setup(
      form({ fields: [form().fields[0]!, { ...form().fields[1]!, showWhen: [{ fieldId: "q1", operator: "equals", value: "A friend" }] }, form().fields[2]!] }),
      () => new Response(JSON.stringify({ error: { code: "form_definition_invalid", message: "Pick a question.", fieldErrors: { "fields.1.showWhen.0.value": ["Choose the answer this depends on."] } } }), { status: 422 }),
    );
    const user = userEvent.setup();
    await openForm(user);
    await user.click(screen.getByRole("button", { name: "Save booking form" }));
    expect(await within(question(2)).findByText("Choose the answer this depends on.")).toBeInTheDocument();
  });
});

describe("filled from the link", () => {
  it("saves a hidden question with its link name, and keeps reserved names out", async () => {
    const requests = setup(form());
    const user = userEvent.setup();
    await openForm(user);
    await user.click(within(question(2)).getByRole("switch", { name: "Fill this from the booking link" }));
    expect(within(question(2)).getByText(/\?campaign=diwali/)).toBeInTheDocument();
    expect(within(question(2)).getByText(/name, email, phone, notes, guests, location/)).toBeInTheDocument();
    await user.click(within(question(2)).getByRole("switch", { name: "Hidden (filled from the link)" }));
    // A hidden question has no required switch and no "show this when".
    expect(within(question(2)).queryByRole("switch", { name: "Required" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save booking form" }));
    expect(await within(question(2)).findByText("A hidden question is filled from the booking link, so give it a link name.")).toBeInTheDocument();
    await user.type(within(question(2)).getByLabelText("Link name"), "name");
    await user.click(screen.getByRole("button", { name: "Save booking form" }));
    expect(await within(question(2)).findByText(/already used by the booking page/)).toBeInTheDocument();
    await user.clear(within(question(2)).getByLabelText("Link name"));
    await user.type(within(question(2)).getByLabelText("Link name"), "campaign");
    await user.click(screen.getByRole("button", { name: "Save booking form" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    expect(savedBody(requests).fields[1]).toMatchObject({ id: "q2", hidden: true, prefillKey: "campaign", required: false });
  });

  it("saves a locked, visible prefilled question", async () => {
    const requests = setup(form());
    const user = userEvent.setup();
    await openForm(user);
    await user.click(within(question(3)).getByRole("switch", { name: "Fill this from the booking link" }));
    await user.type(within(question(3)).getByLabelText("Link name"), "topic");
    await user.click(within(question(3)).getByRole("switch", { name: "Lock when filled from the link" }));
    await user.click(screen.getByRole("button", { name: "Save booking form" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    expect(savedBody(requests).fields[2]).toMatchObject({ id: "q3", prefillKey: "topic", lockWhenPrefilled: true, required: true });
  });
});

describe("required on one service", () => {
  const attached = () => form({ appliesToAll: false, serviceIds: [serviceA!.id, serviceB!.id] });

  it("explains itself for a form that is for every service", async () => {
    setup(form());
    await openForm(userEvent.setup());
    expect(screen.getByText(/required or optional for all of them/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Required on one/ })).not.toBeInTheDocument();
  });

  it("stores only the differences, per service", async () => {
    const requests = setup(attached());
    const user = userEvent.setup();
    await openForm(user);
    await user.click(screen.getByRole("button", { name: /Required on one/ }));
    await user.click(await screen.findByRole("combobox", { name: "Anything else?: required on this appointment type" }));
    await user.click(await screen.findByRole("option", { name: "Optional" }));
    await user.click(await screen.findByRole("combobox", { name: "Which friend?: required on this appointment type" }));
    await user.click(await screen.findByRole("option", { name: "Required" }));
    await user.click(screen.getByRole("button", { name: "Save booking form" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    expect(savedBody(requests).requiredOverrides).toEqual({ [serviceA!.id]: { q3: false, q2: true } });
  });

  it("goes back to the form's own setting with 'Same as form'", async () => {
    const requests = setup({ ...attached(), requiredOverrides: { [serviceA!.id]: { q3: false } } });
    const user = userEvent.setup();
    await openForm(user);
    await user.click(screen.getByRole("button", { name: /Required on one/ }));
    const select = await screen.findByRole("combobox", { name: "Anything else?: required on this appointment type" });
    expect(select).toHaveTextContent("Optional");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: /Same as form/ }));
    await user.click(screen.getByRole("button", { name: "Save booking form" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    expect(savedBody(requests).requiredOverrides).toBeUndefined();
  });
});

describe("rules", () => {
  const fields = form().fields;

  it("blocks a move only when a later question depends on the earlier one", () => {
    const dependent = [fields[0]!, { ...fields[1]!, showWhen: [{ fieldId: "q1", operator: "equals" as const, value: "A friend" }] }, fields[2]!];
    expect(moveBlocker(dependent, 1, -1)).toMatch(/Question 2 is shown only for an answer to question 1/);
    expect(moveBlocker(dependent, 0, 1)).toMatch(/Question 2/);
    expect(moveBlocker(dependent, 1, 1)).toBeNull();
  });

  it("drops overrides for services that were unticked and ones that match the form", () => {
    const draft = { name: "x", description: "", fields, isActive: true, appliesToAll: false, serviceIds: ["a"], requiredOverrides: { a: { q3: true, q2: true }, b: { q2: true } } };
    expect(prunedOverrides(draft)).toEqual({ a: { q2: true } });
    expect(prunedOverrides({ ...draft, appliesToAll: true })).toBeUndefined();
    expect(setRequiredChoice(undefined, "a", fields[2]!, "required")).toBeUndefined();
  });
});
