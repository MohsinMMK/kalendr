/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import { copilotRequestSchema } from "@/lib/assistant-contracts";

import { CopilotPanel } from "./copilot-panel";
import { starterPrompts } from "./starter-prompts";

// jsdom has no FontFaceSet; the coss Composer re-measures its input when fonts finish loading.
if (!("fonts" in document)) Object.defineProperty(document, "fonts", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });

// A desktop: Enter sends only with a fine pointer, and the keyboard hint is shown.
beforeEach(() => {
  const query = (text: string) => ({ matches: text.includes("pointer: fine"), media: text, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  vi.stubGlobal("matchMedia", query);
  window.matchMedia = query as unknown as typeof window.matchMedia;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const frame = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (chunks: unknown[]): Response => new Response(
  new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(frame(chunk))); controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close(); } }),
  { status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } },
);
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const proposal = { id: "proposal-id-0123456789", kind: "book", summary: "Book Meera Rao for Haircut with Sam on Monday 9:00.", expiresAt: new Date(Date.now() + 25 * 60_000).toISOString() };
const suggestion = [
  { type: "data-conversation", data: { id: "conv-0000001" }, transient: true },
  { type: "start", messageId: "m1" },
  { type: "start-step" },
  { type: "tool-input-available", toolCallId: "c1", toolName: "search_customers", input: { name: "Rao" } },
  { type: "tool-output-available", toolCallId: "c1", output: { customers: [{ id: "cust-1", name: "Meera Rao" }] } },
  { type: "tool-input-available", toolCallId: "c2", toolName: "find_times", input: {} },
  { type: "tool-output-available", toolCallId: "c2", output: { error: "No times." } },
  { type: "data-proposal", id: proposal.id, data: proposal },
  { type: "finish-step" },
  { type: "start-step" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "I suggest a booking. Press Confirm to book it." },
  { type: "text-end", id: "t1" },
  { type: "finish-step" },
  { type: "finish" },
];

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const entry = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} };
    // What the real hook sends must be what the route accepts (ids, trigger, no extra shape).
    if (entry.method === "POST") expect(copilotRequestSchema.safeParse(entry.body).success).toBe(true);
    requests.push(entry);
    return respond(entry.url, init ?? {});
  }));
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><ToastProvider><CopilotPanel /></ToastProvider></QueryClientProvider>);
  return { requests, user };
}

async function openCopilot(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open the copilot" }));
  return screen.findByRole("dialog", { name: "Copilot" });
}

describe("the staff copilot panel", () => {
  it("offers four starter questions on an empty chat, sends one when pressed, and hides them once there are messages", async () => {
    const { requests, user } = setup(() => sse(suggestion));
    const copilot = await openCopilot(user);
    const starters = within(within(copilot).getByRole("group", { name: "Suggested questions" })).getAllByRole("button");
    expect(starters.map((button) => button.textContent)).toEqual(starterPrompts({ customers: "patients" }));
    expect(starters).toHaveLength(4);
    await user.click(within(copilot).getByRole("button", { name: "Find a free hour on Friday" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.body).toMatchObject({ trigger: "submit-message", message: { text: "Find a free hour on Friday" } });
    await within(copilot).findByRole("group", { name: "Confirm this booking" });
    expect(within(copilot).queryByRole("group", { name: "Suggested questions" })).not.toBeInTheDocument();
  });

  it("streams an answer with a short tool step, and books only when Confirm and book is pressed", async () => {
    const { requests, user } = setup((_url, init) => (init.method === "PUT" ? json(200, { data: { appointmentId: "a1", summary: proposal.summary } }) : sse(suggestion)));
    const copilot = await openCopilot(user);
    expect(within(copilot).getByText("Try one of these:")).toBeInTheDocument();

    await user.type(within(copilot).getByLabelText("Your question"), "Find a slot for Rao next week");
    await user.click(within(copilot).getByRole("button", { name: "Send" }));

    // Only the new question goes up: no history, no role, no parts.
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.url).toBe("/api/staff/assistant");
    expect(requests[0]!.body).toMatchObject({ trigger: "submit-message", message: { text: "Find a slot for Rao next week" } });
    expect(requests[0]!.body.conversationId).toBeUndefined();
    expect(Object.keys(requests[0]!.body).sort()).toEqual(["message", "trigger"]);

    const group = await within(copilot).findByRole("group", { name: "Confirm this booking" });
    expect(within(group).getByText(proposal.summary)).toBeInTheDocument();
    const log = within(copilot).getByRole("log", { name: "Copilot conversation" });
    expect(within(log).getByText("I suggest a booking. Press Confirm to book it.")).toBeInTheDocument();
    // The finished answer is read out once, by the status region, and not word by word from the log.
    expect(log).toHaveAttribute("aria-live", "off");
    expect(within(copilot).getAllByRole("status", { hidden: true }).some((region) => region.textContent === "I suggest a booking. Press Confirm to book it.")).toBe(true);
    expect(within(copilot).getByText("Finding the customer")).toBeInTheDocument();
    expect(within(copilot).getByText("Finding free times: that didn't work")).toBeInTheDocument();
    // A suggestion is not a booking.
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(0);

    await user.click(within(group).getByRole("button", { name: "Confirm and book" }));
    await waitFor(() => expect(within(copilot).getByText(/^Done\. Book Meera/)).toBeInTheDocument());
    expect(requests.at(-1)).toMatchObject({ method: "PUT", body: { conversationId: "conv-0000001", proposalId: proposal.id } });
    expect(within(copilot).queryByRole("group", { name: "Confirm this booking" })).not.toBeInTheDocument();
  });

  it("sends a typed question with Enter, keeps the chat id for the next one, and hides a suggestion once a new question is asked", async () => {
    const { requests, user } = setup(() => sse(suggestion));
    const copilot = await openCopilot(user);
    await user.type(within(copilot).getByLabelText("Your question"), "First{Enter}");
    await within(copilot).findByRole("group", { name: "Confirm this booking" });
    await user.type(within(copilot).getByLabelText("Your question"), "Second{Enter}");
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.body.conversationId).toBe("conv-0000001");
    expect((requests[1]!.body.message as { text: string }).text).toBe("Second");
    expect((requests[1]!.body.message as { id: string }).id).not.toBe((requests[0]!.body.message as { id: string }).id);
  });

  it("shows the API's own words when a question is refused before streaming, and tries the same question again", async () => {
    let attempt = 0;
    const { requests, user } = setup(() => {
      attempt += 1;
      return attempt === 1 ? json(429, { error: { code: "rate_limited", message: "Too many questions. Wait a minute." } }) : sse(suggestion);
    });
    const copilot = await openCopilot(user);
    await user.type(within(copilot).getByLabelText("Your question"), "Hello{Enter}");
    expect(await within(copilot).findByText("Too many questions. Wait a minute.")).toBeInTheDocument();

    await user.click(within(copilot).getByRole("button", { name: "Try again" }));
    await within(copilot).findByRole("group", { name: "Confirm this booking" });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.trigger).toBe("regenerate-message");
    expect((requests[1]!.body.message as { id: string }).id).toBe((requests[0]!.body.message as { id: string }).id);
    expect((requests[1]!.body.message as { text: string }).text).toBe("Hello");
  });

  it("offers a new chat when the chat is full and no retry for a used-up allowance", async () => {
    const { user } = setup(() => json(409, { error: { code: "conversation_full", message: "This chat is long. Start a new one." } }));
    const copilot = await openCopilot(user);
    await user.type(within(copilot).getByLabelText("Your question"), "Hello{Enter}");
    expect(await within(copilot).findByText("This chat is long. Start a new one.")).toBeInTheDocument();
    expect(within(copilot).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    await user.click(within(copilot).getByRole("button", { name: "Start a new chat" }));
    expect(within(copilot).getByText("Try one of these:")).toBeInTheDocument();
  });

  it("shows a plain message for a failure while streaming, never the provider's text", async () => {
    const { user } = setup(() => sse([{ type: "start", messageId: "m1" }, { type: "error", errorText: "The copilot couldn't answer just now." }]));
    const copilot = await openCopilot(user);
    await user.type(within(copilot).getByLabelText("Your question"), "Hello{Enter}");
    expect(await within(copilot).findByText("The copilot couldn't answer just now.")).toBeInTheDocument();
    expect(within(copilot).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows a Stop button while the answer is coming, blocks a second question, and stops the request", async () => {
    let signal: AbortSignal | null | undefined;
    const { requests, user } = setup((_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame({ type: "start", messageId: "m1" }))); } }), { status: 200, headers: { "x-vercel-ai-ui-message-stream": "v1" } });
    });
    const copilot = await openCopilot(user);
    await user.type(within(copilot).getByLabelText("Your question"), "Hello{Enter}");
    const stop = await within(copilot).findByRole("button", { name: "Stop" });
    expect(within(copilot).queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    await user.type(within(copilot).getByLabelText("Your question"), "Another{Enter}");
    expect(requests).toHaveLength(1);
    await user.click(stop);
    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(await within(copilot).findByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});
