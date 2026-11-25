/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assistantChatRequestSchema } from "@/lib/assistant-contracts";

import { AssistantChat } from "./assistant-chat";

// A desktop: Enter sends only with a fine pointer, and the keyboard hint is shown. (src/test/setup.ts stubs document.fonts.)
beforeEach(() => {
  const query = (text: string) => ({ matches: text.includes("pointer: fine"), media: text, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  vi.stubGlobal("matchMedia", query);
  window.matchMedia = query as unknown as typeof window.matchMedia;
  window.sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const config = { enabled: true, businessName: "Lotus Dental", bookingLink: "https://app.test/book/lotus", greeting: "Chat" };
const token = "t".repeat(43);
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const read = (transcript: unknown = null): Response => json(200, { data: { config, transcript } });

const frame = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`;
const sse = (chunks: unknown[]): Response => new Response(
  new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(frame(chunk))); controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close(); } }),
  { status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } },
);
const state = (extra: Record<string, unknown> = {}) => ({ type: "data-conversation", transient: true, data: { status: "active", awaitingCode: false, verified: false, ...extra } });
/** What the server streams for one answer: the chat's state, the words, and any typed parts. */
const answer = (words: string[], extra: unknown[] = [], conversation: Record<string, unknown> = {}) => [
  state({ token, ...conversation }), { type: "start" },
  ...words.flatMap((text, index) => [{ type: "text-start", id: `t${index}` }, { type: "text-delta", id: `t${index}`, delta: text }, { type: "text-end", id: `t${index}` }]),
  ...extra, state(conversation), { type: "finish" },
];

function setup(respond: (init: RequestInit, index: number) => Response | Promise<Response>) {
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== "POST") return read();
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // What the real hook sends must be what the route accepts: one message, one tapped Confirm or one code, and nothing else.
    expect(assistantChatRequestSchema.safeParse(body).success).toBe(true);
    posts.push(body);
    return respond(init, posts.length);
  }));
  return { posts, user: userEvent.setup() };
}

/** The conversation log. The finished answer is also read out in a status region, so a reply's words are looked for in the log. */
const logOf = (dialog: HTMLElement) => within(within(dialog).getByRole("log", { name: "Conversation" }));

async function openChat(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Ask us" }));
  return screen.findByRole("dialog");
}

describe("the website chat", () => {
  it("shows nothing when the business has the chat off", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(200, { data: { config: { ...config, enabled: false }, transcript: null } })));
    vi.stubGlobal("fetch", fetchMock);
    render(<AssistantChat clinicSlug="lotus" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Ask us" })).toBeNull();
  });

  it("says it is automated, streams the answer, and keeps the chat token for this tab only", async () => {
    const { posts, user } = setup(() => sse(answer(["Hi, I'm Lotus Dental's automated booking assistant, not a person.", "Here are some times."])));
    render(<AssistantChat clinicSlug="lotus" />);
    const dialog = await openChat(user);
    expect(within(dialog).getByText("Automated assistant")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Your message"), "hello");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    const log = within(dialog).getByRole("log", { name: "Conversation" });
    expect(await within(log).findByText(/automated booking assistant, not a person/)).toBeInTheDocument();
    expect(within(log).getByText(/Here are some times/)).toBeInTheDocument();
    expect(window.sessionStorage.getItem("kalendr-assistant-lotus")).toBe(token);
    expect(posts[0]).toEqual({ business: "lotus", text: "hello" });
    // The finished answer is read out once, by the status region, and not word by word from the log.
    expect(log).toHaveAttribute("aria-live", "off");
    await waitFor(() => expect(within(dialog).getAllByRole("status").some((region) => /Here are some times/.test(region.textContent ?? ""))).toBe(true));
  });

  it("sends the saved token on the next message and shows the saved chat after a reload", async () => {
    window.sessionStorage.setItem("kalendr-assistant-lotus", token);
    const requests: string[] = [];
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(String(url));
      if (init?.method === "POST") { expect(JSON.parse(String(init.body))).toEqual({ business: "lotus", token, text: "more" }); return sse(answer(["Sure."])); }
      return read({ lines: [{ role: "customer", text: "hello" }, { role: "assistant", text: "Hi there." }], status: "active", awaitingCode: false, verified: false });
    }));
    render(<AssistantChat clinicSlug="lotus" />);
    const dialog = await openChat(user);
    expect(requests[0]).toContain(`token=${token}`);
    expect(await logOf(dialog).findByText("Hi there.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Your message"), "more");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(await logOf(dialog).findByText("Sure.")).toBeInTheDocument();
  });

  it("asks for a Confirm before anything changes, and sends the proposal's own id when pressed", async () => {
    const proposal = { id: "p".repeat(32), kind: "book", summary: "Dental consultation with Dr Rao on Saturday at 3:30 pm.", expiresAt: new Date(Date.now() + 600_000).toISOString() };
    const { posts, user } = setup((_init, index) => sse(index === 1
      ? answer(["Shall I book it?"], [{ type: "data-proposal", id: proposal.id, data: proposal }])
      : answer(["All set."])));
    render(<AssistantChat clinicSlug="lotus" />);
    const dialog = await openChat(user);
    await user.type(within(dialog).getByLabelText("Your message"), "book it");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    const group = await within(dialog).findByRole("group", { name: "Confirm this change" });
    expect(within(group).getByText(/Dental consultation with Dr Rao/)).toBeInTheDocument();
    expect(within(group).getByText(/Nothing changes until you confirm/)).toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "Confirm" }));
    expect(await logOf(dialog).findByText("All set.")).toBeInTheDocument();
    expect(posts[1]).toEqual({ business: "lotus", token, confirmProposalId: proposal.id });
    expect(within(dialog).queryByRole("group", { name: "Confirm this change" })).toBeNull();
  });

  it("keeps the Confirm on offer when sending it fails, so the visitor can tap again", async () => {
    const proposal = { id: "p".repeat(32), kind: "book", summary: "Dental consultation with Dr Rao on Saturday at 3:30 pm.", expiresAt: new Date(Date.now() + 600_000).toISOString() };
    const { posts, user } = setup((_init, index) => {
      if (index === 1) return sse(answer(["Shall I book it?"], [{ type: "data-proposal", id: proposal.id, data: proposal }]));
      if (index === 2) return json(429, { error: { code: "rate_limited", message: "Slow down a little. Wait a minute and try again." } });
      return sse(answer(["All set."]));
    });
    render(<AssistantChat clinicSlug="lotus" />);
    const dialog = await openChat(user);
    await user.type(within(dialog).getByLabelText("Your message"), "book it");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    await user.click(within(await within(dialog).findByRole("group", { name: "Confirm this change" })).getByRole("button", { name: "Confirm" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Slow down a little");
    const again = within(dialog).getByRole("group", { name: "Confirm this change" });
    await user.click(within(again).getByRole("button", { name: "Confirm" }));
    expect(await logOf(dialog).findByText("All set.")).toBeInTheDocument();
    expect(posts.map((body) => body.confirmProposalId).filter(Boolean)).toEqual([proposal.id, proposal.id]);
    expect(within(dialog).queryByRole("group", { name: "Confirm this change" })).toBeNull();
  });

  it("shows the words the server says to keep, not the ones that streamed first", async () => {
    const { user } = setup(() => sse(answer(["You're booked! Your appointment is confirmed."], [{ type: "data-replace", data: { text: "I haven't changed anything yet. Tap Confirm to go ahead." } }])));
    render(<AssistantChat clinicSlug="lotus" />);
    const dialog = await openChat(user);
    await user.type(within(dialog).getByLabelText("Your message"), "book it");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(await logOf(dialog).findByText(/I haven't changed anything yet/)).toBeInTheDocument();
    expect(logOf(dialog).queryByText(/You're booked/)).toBeNull();
  });

  it("shows a code box only while a code is awaited, sends the code without showing it, and says what went wrong", async () => {
    const { posts, user } = setup((_init, index) => {
      if (index === 1) return sse(answer(["I've sent a code."], [], { awaitingCode: true }));
      if (index === 2) return sse(answer(["You're verified."], [], { verified: true }));
      return json(429, { error: { code: "rate_limited", message: "Slow down a little. Wait a minute and try again." } });
    });
    render(<AssistantChat clinicSlug="lotus" />);
    const dialog = await openChat(user);
    await user.type(within(dialog).getByLabelText("Your message"), "my bookings");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(await within(dialog).findByText("Code from your text message")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("textbox", { name: /Code from your text message/ }));
    await user.keyboard("123456");
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ business: "lotus", token, code: "123456" });
    // The digits are never a message in the chat, and the box goes once the phone is verified.
    expect(await logOf(dialog).findByText("You're verified.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/123456|Verifying/)).toBeNull();
    expect(within(dialog).queryByText("Code from your text message")).toBeNull();
    await user.type(within(dialog).getByLabelText("Your message"), "again");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Slow down a little");
  });

  it("offers the booking page when the assistant could only give the link, and tells a handed-off chat the team will read", async () => {
    const link = "https://app.test/book/lotus";
    const { user } = setup(() => sse(answer([`Please use the booking page: ${link}`], [{ type: "data-fallback", data: { link } }], { status: "handed_off" })));
    render(<AssistantChat clinicSlug="lotus" />);
    const dialog = await openChat(user);
    await user.type(within(dialog).getByLabelText("Your message"), "hello");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(await within(dialog).findByRole("link", { name: "book on the booking page" })).toHaveAttribute("href", link);
    expect(within(dialog).getByPlaceholderText("The team will read this")).toBeInTheDocument();
    // Only the business's own address becomes a link.
    expect(within(dialog).getAllByRole("link").filter((anchor) => anchor.getAttribute("href") === link)).toHaveLength(2);
  });
});
